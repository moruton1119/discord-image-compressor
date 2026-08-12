/**
 * Discord 画像/動画 圧縮くん - 動画圧縮モジュール
 * ffmpeg.wasm 0.12 を使用したブラウザ完結型動画圧縮
 * 
 * UMD版を使用（ESM版は一部モバイル環境でimportエラーが出るため）
 */

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

let ffmpeg = null;
let ffmpegReady = false;

// ============ デバッグログ収集 ============
function addDebugLog(level, message) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] [${level}] ${message}`;
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

// ============ ffmpeg UMD版の動的ロード ============
// script タグでUMD版を読み込み、グローバル変数から取得する
async function loadFFmpegUMD() {
  // 既に読み込み済みならグローバルから取得
  if (window.FFmpegWASM && window.FFmpegUtil) {
    return { FFmpeg: window.FFmpegWASM.FFmpeg, fetchFile: window.FFmpegUtil.fetchFile, toBlobURL: window.FFmpegUtil.toBlobURL };
  }

  addDebugLog('LOAD', 'UMD版スクリプトを読み込み中...');

  // UMD版を script タグで読み込む
  await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js');
  addDebugLog('LOAD', 'ffmpeg UMD 読み込みOK');

  await loadScript('https://unpkg.com/@ffmpeg/util@0.12.2/dist/umd/index.js');
  addDebugLog('LOAD', 'ffmpeg util UMD 読み込みOK');

  // グローバル変数から取得（UMD版の公開名）
  // @ffmpeg/ffmpeg UMD版 → window.FFmpegWASM.FFmpeg
  // @ffmpeg/util UMD版 → window.FFmpegUtil.fetchFile / toBlobURL
  const FFmpeg = window.FFmpegWASM ? window.FFmpegWASM.FFmpeg : null;
  const fetchFile = window.FFmpegUtil ? window.FFmpegUtil.fetchFile : null;
  const toBlobURL = window.FFmpegUtil ? window.FFmpegUtil.toBlobURL : null;

  if (!FFmpeg) {
    // フォールバック: 別のグローバル名を試す
    addDebugLog('WARN', `FFmpegWASM not found. グローバルキー一覧: ${Object.keys(window).filter(k => k.toLowerCase().includes('ffmpeg')).join(', ')}`);
    throw new Error('FFmpegクラスが見つかりません (UMD)');
  }

  return { FFmpeg, fetchFile, toBlobURL };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = (e) => reject(new Error(`スクリプト読み込み失敗: ${src}`));
    document.head.appendChild(script);
  });
}

// ============ ffmpeg初期化 ============
async function ensureFFmpeg(onProgress) {
  if (ffmpegReady) return ffmpeg;

  const { FFmpeg, fetchFile: _fetchFile, toBlobURL: _toBlobURL } = await loadFFmpegUMD();

  // グローバルに保存（後でcompressVideo内で使う）
  window._fetchFile = _fetchFile;
  window._toBlobURL = _toBlobURL;

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
  const FFMPEG_CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
  const FFMPEG_WORKER_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js';

  addDebugLog('LOAD', 'ffmpeg core + worker を読み込み中...');
  try {
    const coreURL = await _toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.js`, 'text/javascript');
    addDebugLog('LOAD', 'ffmpeg-core.js 取得OK');
    const wasmURL = await _toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.wasm`, 'application/wasm');
    addDebugLog('LOAD', 'ffmpeg-core.wasm 取得OK');
    const classWorkerURL = await _toBlobURL(FFMPEG_WORKER_URL, 'text/javascript');
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
  addDebugLog('INFO', `ファイルサイズ: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
  addDebugLog('INFO', `MIME Type: ${file.type}`);

  onStatus?.('ffmpeg.wasm を読み込み中...');
  const ff = await ensureFFmpeg(onProgress);
  const fetchFile = window._fetchFile;

  const inputName = 'input_video';
  const outputName = 'output.mp4';

  addDebugLog('STEP', '動画データをffmpeg仮想FSに書き込み中...');
  onStatus?.('動画データを読み込み中...');
  const fileData = await fetchFile(file);
  await ff.writeFile(inputName, fileData);
  addDebugLog('STEP', `仮想FS書き込み完了: ${fileData.length} bytes`);

  // 動画の長さを取得
  onStatus?.('動画情報を解析中...');
  const duration = await getVideoDuration(file);
  addDebugLog('INFO', `動画の長さ: ${duration.toFixed(1)}秒`);

  // 目標ビットレートを計算
  const audioBitrateKbps = 96;
  const targetVideoBitrateKbps = Math.floor(
    (TARGET_SIZE_BYTES * 8 / 1000 / duration) - audioBitrateKbps
  );
  addDebugLog('INFO', `目標ビデオビットレート: ${targetVideoBitrateKbps}kbps`);

  // Step 1: 計算したビットレートで圧縮
  onStatus?.(`圧縮中... ( bitrate: ${targetVideoBitrateKbps}kbps )`);
  let result = await tryCompress(ff, inputName, outputName, targetVideoBitrateKbps, audioBitrateKbps);

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
    result = await tryCompress(ff, inputName, outputName, currentBitrate, audioBitrateKbps);
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
      result = await tryCompressWithScale(ff, inputName, outputName, currentBitrate, audioBitrateKbps, scale);
      if (result && result.size <= TARGET_SIZE_BYTES) {
        compressedSize = result.size;
        addDebugLog('INFO', `${scale}で目標達成: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
        break;
      }
      if (result) compressedSize = result.size;
    }
  }

  // クリーンアップ
  try { await ff.deleteFile(inputName); } catch(e) {}
  try { await ff.deleteFile(outputName); } catch(e) {}

  if (!result) throw new Error('動画の圧縮に失敗しました');

  const blob = new Blob([result.buffer], { type: 'video/mp4' });
  addDebugLog('INFO', `圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

  return { blob, originalSize: file.size, compressedSize: blob.size };
}

// ============ ヘルパー関数 ============

// 動画の長さを取得（ファイルURLから直接取得・シンプル版）
async function getVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      const d = video.duration;
      addDebugLog('INFO', `動画の長さ取得: ${d}秒`);
      resolve(d || 60);
    };
    video.onerror = () => {
      addDebugLog('WARN', '動画の長さ取得失敗、60秒と仮定');
      resolve(60);
    };
    video.src = URL.createObjectURL(file);
  });
}

async function tryCompress(ff, inputName, outputName, videoBitrate, audioBitrate) {
  try {
    addDebugLog('FFMPEG', `エンコード開始: -b:v ${videoBitrate}k -b:a ${audioBitrate}k`);
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
    addDebugLog('FFMPEG', `エンコード完了: ${data.length} bytes`);
    return { buffer: data.buffer, size: data.length };
  } catch (err) {
    addDebugLog('ERROR', `圧縮エラー: ${err.message || err}`);
    return null;
  }
}

async function tryCompressWithScale(ff, inputName, outputName, videoBitrate, audioBitrate, scale) {
  try {
    addDebugLog('FFMPEG', `エンコード開始(scale=${scale}): -b:v ${videoBitrate}k`);
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
    addDebugLog('FFMPEG', `エンコード完了: ${data.length} bytes`);
    return { buffer: data.buffer, size: data.length };
  } catch (err) {
    addDebugLog('ERROR', `圧縮エラー: ${err.message || err}`);
    return null;
  }
}
