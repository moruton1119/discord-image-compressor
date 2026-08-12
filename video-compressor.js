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
 */

import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js';

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

// ffmpeg core のCDN URL
const FFMPEG_CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
// シングルスレッド版（SharedArrayBuffer不要・GitHub Pages対応）
// マルチスレッド版を使う場合は core-mt だが、COOP/COEPヘッダーが必要

let ffmpeg = null;
let ffmpegReady = false;

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
    console.log('[ffmpeg]', message);
  });

  // CDNからコアを読み込む
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegReady = true;
  return ffmpeg;
}

// ============ 動画圧縮メイン ============

/**
 * 動画を10MB以下に圧縮する
 * @param {File} file - 動画ファイル
 * @param {function} onProgress - 進捗コールバック(0-100)
 * @param {function} onStatus - ステータステキスト更新コールバック
 * @returns {Promise<{blob: Blob, originalSize: number, compressedSize: number}>}
 */
export async function compressVideo(file, onProgress, onStatus) {
  console.log(`🎬 動画圧縮開始: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

  onStatus?.('ffmpeg.wasm を読み込み中...');
  const ff = await ensureFFmpeg(onProgress);

  const inputName = 'input_video';
  const outputName = 'output.mp4';

  // 入力ファイルをffmpegの仮想FSに書き込む
  onStatus?.('動画データを読み込み中...');
  const fileData = await fetchFile(file);
  await ff.writeFile(inputName, fileData);

  // 動画の長さを取得（ffprobe相当）
  onStatus?.('動画情報を解析中...');
  const duration = await getVideoDuration(ff, inputName);
  console.log(`📏 動画の長さ: ${duration.toFixed(1)}秒`);

  // 目標ビットレートを計算
  // bitrate(kbps) = targetSize(KB) × 8 / duration(s)
  // 10MB = 10240KB, 音声を考慮して少し余裕を持たせる
  const audioBitrateKbps = 96; // 音声ビットレート
  const targetVideoBitrateKbps = Math.floor(
    (TARGET_SIZE_BYTES * 8 / 1000 / duration) - audioBitrateKbps
  );

  console.log(`🎯 目標ビデオビットレート: ${targetVideoBitrateKbps}kbps`);

  // Step 1: 計算したビットレートで圧縮
  onStatus?.(`圧縮中... ( bitrate: ${targetVideoBitrateKbps}kbps )`);
  
  let result = await tryCompress(ff, inputName, outputName, targetVideoBitrateKbps, audioBitrateKbps, onProgress);

  if (!result) {
    throw new Error('動画の圧縮に失敗しました');
  }

  let compressedSize = result.size;
  console.log(`📦 1回目: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);

  // Step 2: サイズオーバーの場合はビットレートを下げて再トライ（最大3回）
  let currentBitrate = targetVideoBitrateKbps;
  let retryCount = 0;
  const maxRetries = 3;

  while (compressedSize > TARGET_SIZE_BYTES && retryCount < maxRetries) {
    retryCount++;
    // ビットレートを20%カット
    currentBitrate = Math.floor(currentBitrate * 0.8);
    
    onStatus?.(`再圧縮中... ( bitrate: ${currentBitrate}kbps ) [${retryCount}/${maxRetries}]`);
    console.log(`🔄 再圧縮 ${retryCount}: bitrate=${currentBitrate}kbps`);

    // クリーンアップして再トライ
    try { await ff.deleteFile(outputName); } catch(e) {}

    result = await tryCompress(ff, inputName, outputName, currentBitrate, audioBitrateKbps, onProgress);
    if (result) {
      compressedSize = result.size;
      console.log(`📦 再圧縮${retryCount}回目: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  // Step 3: まだダメなら解像度も下げる
  if (compressedSize > TARGET_SIZE_BYTES) {
    onStatus?.('解像度を下げて圧縮中...');
    console.log('📐 解像度ダウンスケール開始');

    const scales = ['1280:-2', '960:-2', '640:-2', '480:-2'];
    
    for (const scale of scales) {
      try { await ff.deleteFile(outputName); } catch(e) {}

      onStatus?.(`解像度 ${scale.split(':')[0]}px で圧縮中...`);
      result = await tryCompressWithScale(ff, inputName, outputName, currentBitrate, audioBitrateKbps, scale, onProgress);
      
      if (result && result.size <= TARGET_SIZE_BYTES) {
        compressedSize = result.size;
        console.log(`✅ ${scale}で目標達成: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
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
  console.log(`🎉 圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

  return {
    blob,
    originalSize: file.size,
    compressedSize: blob.size,
  };
}

// ============ ヘルパー関数 ============

/**
 * ffmpegで動画の長さを取得
 */
async function getVideoDuration(ff, filename) {
  // HTML5 video elementを使ってdurationを取得（より確実）
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration || 60); // 取得失敗時は60秒と仮定
    };
    video.onerror = () => {
      resolve(60); // フォールバック
    };
    video.src = URL.createObjectURL(new Blob([await ff.readFile(filename)]));
  });
}

/**
 * ビットレート指定で圧縮を試行
 */
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
    console.error('圧縮エラー:', err);
    return null;
  }
}

/**
 * スケール指定付きで圧縮を試行
 */
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
    console.error('圧縮エラー:', err);
    return null;
  }
}
