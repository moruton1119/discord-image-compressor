/**
 * Discord 画像/動画 圧縮くん - 動画圧縮モジュール
 * ffmpeg.wasm 0.12 を使用したブラウザ完結型動画圧縮
 * 
 * 圧縮ロジック:
 * 1. 動画の長さを取得
 * 2. 目標サイズ(10MB)から逆算でビットレートを計算
 * 3. ffmpeg でH.264エンコード + ビットレート指定
 * 4. サイズオーバーの場合はビットレートを下げて再トライ
 * 
 * 全処理がブラウザ内で完結（サーバー通信なし）
 * 
 * 【重要】ffmpeg.wasm 0.12 は Web Worker 上で動くため
 * classWorkerURL の指定が必須（指定しないとWorkerが見つからずエラー）
 */

import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js';

// ffmpeg core と worker のCDN URL
const FFMPEG_CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
const FFMPEG_WORKER_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js';

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

let ffmpeg = null;
let ffmpegReady = false;

// ============ デバッグログ収集 ============
const debugLogs = [];

function addDebugLog(level, message) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] [${level}] ${message}`;
  debugLogs.push(entry);
  console.log(entry);
  const panel = document.getElementById('debugPanel');
  if (panel) {
    const line = document.createElement('div');
    line.className = `debug-line debug-${level.toLowerCase()}`;
    line.textContent = entry;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
  }
}

// ブラウザ環境情報
export function logBrowserInfo() {
  addDebugLog('INFO', `UA: ${navigator.userAgent}`);
  addDebugLog('INFO', `Platform: ${navigator.platform}`);
  addDebugLog('INFO', `SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined' ? '✅ 利用可能' : '❌ 利用不可'}`);
  addDebugLog('INFO', `crossOriginIsolated: ${self.crossOriginIsolated}`);
  addDebugLog('INFO', `WebAssembly: ${typeof WebAssembly !== 'undefined' ? '✅' : '❌'}`);
  addDebugLog('INFO', `Device Memory: ${navigator.deviceMemory || 'unknown'} GB`);
  addDebugLog('INFO', `Hardware Concurrency: ${navigator.hardwareConcurrency || 'unknown'} cores`);
}

// グローバルエラーハンドラー
window.addEventListener('error', (e) => {
  addDebugLog('ERROR', `グローバルエラー: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  addDebugLog('ERROR', `Unhandled Promise: ${e.reason}`);
});

// console.error をフック
const _consoleError = console.error;
console.error = (...args) => {
  addDebugLog('ERROR', args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
  _consoleError.apply(console, args);
};

// ============ ffmpeg初期化 ============
async function ensureFFmpeg(onProgress) {
  if (ffmpegReady) return ffmpeg;

  ffmpeg = new FFmpeg();

  // 進捗コールバック
  if (onProgress) {
    ffmpeg.on('progress', ({ progress, time }) => {
      const percent = Math.min(Math.max(progress * 100, 0), 100);
      onProgress(percent);
    });
  }

  ffmpeg.on('log', ({ message }) => {
    addDebugLog('FFMPEG', message);
  });

  // CDNからコアとWorkerを読み込む
  // 【重要】classWorkerURLを指定しないとWorkerがバンドルされて見つからずエラーになる
  addDebugLog('LOAD', 'ffmpeg core + worker をCDNから読み込み中...');
  try {
    const coreURL = await toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.js`, 'text/javascript');
    addDebugLog('LOAD', 'ffmpeg-core.js 取得OK');
    const wasmURL = await toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.wasm`, 'application/wasm');
    addDebugLog('LOAD', 'ffmpeg-core.wasm 取得OK');
    // Worker.jsもBlob URL化してCORS回避
    const classWorkerURL = await toBlobURL(FFMPEG_WORKER_URL, 'text/javascript');
    addDebugLog('LOAD', 'worker.js 取得OK');
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
    addDebugLog('LOAD', 'ffmpeg.load() 完了!');
  } catch (loadErr) {
    addDebugLog('ERROR', `ffmpeg.load() 失敗: ${loadErr.message || loadErr}`);
    throw loadErr;
  }

  ffmpegReady = true;
  return ffmpeg;
}

// ============ 動画圧縮メイン ============

export async function compressVideo(file, onProgress, onStatus) {
  addDebugLog('INFO', `動画圧縮開始: ${file.name}`);
  addDebugLog('INFO', `ファイルサイズ: ${(file.size / 1024 / 1024).toFixed(2)} MB (${file.size} bytes)`);
  addDebugLog('INFO', `MIME Type: ${file.type}`);

  onStatus?.('ffmpeg.wasm を読み込み中...');
  const ff = await ensureFFmpeg(onProgress);

  const inputName = 'input_video';
  const outputName = 'output.mp4';

  addDebugLog('STEP', '動画データをffmpeg仮想FSに書き込み中...');
  // 入力ファイルをffmpegの仮想FSに書き込む
  onStatus?.('動画データを読み込み中...');
  const fileData = await fetchFile(file);
  await ff.writeFile(inputName, fileData);
  addDebugLog('STEP', `仮想FS書き込み完了: ${fileData.length} bytes`);

  // 動画の長さを取得
  onStatus?.('動画情報を解析中...');
  const duration = await getVideoDuration(ff, inputName);
  addDebugLog('INFO', `動画の長さ: ${duration.toFixed(1)}秒`);

  // 目標ビットレートを計算
  const audioBitrateKbps = 96;
  const targetVideoBitrateKbps = Math.floor(
    (TARGET_SIZE_BYTES * 8 / 1000 / duration) - audioBitrateKbps
  );
  addDebugLog('INFO', `目標ビデオビットレート: ${targetVideoBitrateKbps}kbps`);

  // Step 1: 計算したビットレートで圧縮
  onStatus?.(`圧縮中... ( bitrate: ${targetVideoBitrateKbps}kbps )`);

  let result = await tryCompress(ff, inputName, outputName, targetVideoBitrateKbps, audioBitrateKbps, onProgress);

  if (!result) {
    throw new Error('動画の圧縮に失敗しました');
  }

  let compressedSize = result.size;
  addDebugLog('INFO', `1回目: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);

  // Step 2: サイズオーバーの場合はビットレートを下げて再トライ（最大3回）
  let currentBitrate = targetVideoBitrateKbps;
  let retryCount = 0;
  const maxRetries = 3;

  while (compressedSize > TARGET_SIZE_BYTES && retryCount < maxRetries) {
    retryCount++;
    currentBitrate = Math.floor(currentBitrate * 0.8);

    onStatus?.(`再圧縮中... ( bitrate: ${currentBitrate}kbps ) [${retryCount}/${maxRetries}]`);
    addDebugLog('STEP', `再圧縮 ${retryCount}: bitrate=${currentBitrate}kbps`);

    try { await ff.deleteFile(outputName); } catch(e) {}

    result = await tryCompress(ff, inputName, outputName, currentBitrate, audioBitrateKbps, onProgress);
    if (result) {
      compressedSize = result.size;
      addDebugLog('INFO', `再圧縮${retryCount}回目: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  // Step 3: まだダメなら解像度も下げる
  if (compressedSize > TARGET_SIZE_BYTES) {
    onStatus?.('解像度を下げて圧縮中...');
    addDebugLog('STEP', '解像度ダウンスケール開始');

    const scales = ['1280:-2', '960:-2', '640:-2', '480:-2'];

    for (const scale of scales) {
      try { await ff.deleteFile(outputName); } catch(e) {}

      onStatus?.(`解像度 ${scale.split(':')[0]}px で圧縮中...`);
      result = await tryCompressWithScale(ff, inputName, outputName, currentBitrate, audioBitrateKbps, scale, onProgress);

      if (result && result.size <= TARGET_SIZE_BYTES) {
        compressedSize = result.size;
        addDebugLog('INFO', `${scale}で目標達成: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
        break;
      }
      if (result) {
        compressedSize = result.size;
      }
    }
  }

  // クリーンアップ
  try { await ff.deleteFile(inputName); } catch(e) {}
  try { await ff.deleteFile(outputName); } catch(e) {}

  if (!result) {
    throw new Error('動画の圧縮に失敗しました');
  }

  const blob = new Blob([result.buffer], { type: 'video/mp4' });
  addDebugLog('INFO', `圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

  return {
    blob,
    originalSize: file.size,
    compressedSize: blob.size,
  };
}

// ============ ヘルパー関数 ============

async function getVideoDuration(ff, filename) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration || 60);
    };
    video.onerror = () => {
      resolve(60);
    };
    video.src = URL.createObjectURL(new Blob([Uint8Array.from(await ff.readFile(filename))]));
  });
}

async function tryCompress(ff, inputName, outputName, videoBitrate, audioBitrate, onProgress) {
  try {
    await ff.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.floor(videoBitrate * 1.5)}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-preset', 'fast',
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-movflags', '+faststart',
      '-y',
      outputName,
    ]);

    const data = await ff.readFile(outputName);
    return { buffer: data.buffer, size: data.length };
  } catch (err) {
    addDebugLog('ERROR', `圧縮エラー: ${err.message || err}`);
    return null;
  }
}

async function tryCompressWithScale(ff, inputName, outputName, videoBitrate, audioBitrate, scale, onProgress) {
  try {
    await ff.exec([
      '-i', inputName,
      '-vf', `scale=${scale}`,
      '-c:v', 'libx264',
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.floor(videoBitrate * 1.5)}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-preset', 'fast',
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-movflags', '+faststart',
      '-y',
      outputName,
    ]);

    const data = await ff.readFile(outputName);
    return { buffer: data.buffer, size: data.length };
  } catch (err) {
    addDebugLog('ERROR', `圧縮エラー: ${err.message || err}`);
    return null;
  }
}
