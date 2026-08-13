/**
 * Discord 画像/動画 圧縮くん - 動画圧縮モジュール
 * ffmpeg.wasm 0.11 を使用（0.12はWorkerパス問題でGitHub Pages非対応のため）
 * 
 * 0.11は createFFmpeg API でシンプルかつ確実に動作
 * SharedArrayBuffer不要・シングルスレッド・GitHub Pages環境対応
 */

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

let ffmpegInstance = null;
let ffmpegReady = false;

// ============ デバッグログ ============
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

// ============ ffmpeg 0.11 初期化 ============
async function ensureFFmpeg(onProgress) {
  if (ffmpegReady) return ffmpegInstance;

  // ffmpeg.wasm 0.11 の UMD版を読み込み
  if (!window.createFFmpeg) {
    addDebugLog('LOAD', 'ffmpeg.wasm 0.11 UMD版を読み込み中...');
    // @ffmpeg/core-st (single thread版・SharedArrayBuffer不要)
    await loadScript('https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js');
    addDebugLog('LOAD', 'ffmpeg-core.js (ST版) 読み込みOK');

    // @ffmpeg/ffmpeg 0.11 を読み込む
    await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
    addDebugLog('LOAD', 'ffmpeg.min.js 読み込みOK');

    if (!window.FFmpeg) {
      throw new Error('FFmpegグローバルが見つかりません');
    }
  }

  // createFFmpeg でインスタンス生成
  const { createFFmpeg } = window.FFmpeg;

  ffmpegInstance = createFFmpeg({
    log: true,
    // core-st (single thread版) を指定 - SharedArrayBuffer不要!
    corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
    // core-stは proxy_main ではなく _main を使うため、mainNameを指定
    mainName: 'main',
    progress: ({ ratio }) => {
      if (ratio >= 0 && ratio <= 1 && onProgress) {
        onProgress(ratio * 100);
      }
    },
  });

  addDebugLog('LOAD', 'ffmpeg.load() を実行中...');
  await ffmpegInstance.load();
  addDebugLog('LOAD', 'ffmpeg.load() 完了!');

  ffmpegReady = true;
  return ffmpegInstance;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    // 既に読み込み済みかチェック
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`スクリプト読み込み失敗: ${src}`));
    document.head.appendChild(script);
  });
}

// ============ 動画圧縮メイン ============

export async function compressVideo(file, onProgress, onStatus) {
  addDebugLog('INFO', `動画圧縮開始: ${file.name}`);
  addDebugLog('INFO', `ファイルサイズ: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
  addDebugLog('INFO', `MIME Type: ${file.type}`);

  onStatus?.('ffmpeg.wasm を読み込み中...');
  const ff = await ensureFFmpeg(onProgress);

  const inputExt = file.name.split('.').pop() || 'mp4';
  const inputName = `input.${inputExt}`;
  const outputName = 'output.mp4';

  // 入力ファイルを仮想FSに書き込む
  onStatus?.('動画データを読み込み中...');
  addDebugLog('STEP', '仮想FSに書き込み中...');

  // メモリ使用量チェック（大雑把）
  const fileSizeMB = file.size / 1024 / 1024;
  const deviceMemory = navigator.deviceMemory || 4; // GB
  if (fileSizeMB > deviceMemory * 1024 * 0.4) {
    addDebugLog('WARN', `ファイルサイズ(${fileSizeMB.toFixed(1)}MB)がデバイスメモリ(${deviceMemory}GB)に対して大きいです。メモリ不足で失敗する可能性があります。`);
  }

  const fileData = new Uint8Array(await file.arrayBuffer());
  ff.FS('writeFile', inputName, fileData);
  addDebugLog('STEP', `書き込み完了: ${fileData.length} bytes`);

  // 動画の長さを取得
  onStatus?.('動画情報を解析中...');
  const duration = await getVideoDuration(file);
  addDebugLog('INFO', `動画の長さ: ${duration.toFixed(1)}秒`);

  // 目標ビットレート計算
  const audioBitrateKbps = 96;
  const targetVideoBitrateKbps = Math.floor(
    (TARGET_SIZE_BYTES * 8 / 1000 / duration) - audioBitrateKbps
  );
  addDebugLog('INFO', `目標ビデオビットレート: ${targetVideoBitrateKbps}kbps`);

  // Step 1: ビットレート指定で圧縮
  onStatus?.(`圧縮中... ( bitrate: ${targetVideoBitrateKbps}kbps )`);
  let result = await tryCompress(ff, inputName, outputName, targetVideoBitrateKbps, audioBitrateKbps);

  if (!result) {
    throw new Error('動画の圧縮に失敗しました');
  }

  let compressedSize = result.length;
  addDebugLog('INFO', `1回目: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);

  // Step 2: サイズオーバー時の再圧縮
  let currentBitrate = targetVideoBitrateKbps;
  let retryCount = 0;
  const maxRetries = 3;

  while (compressedSize > TARGET_SIZE_BYTES && retryCount < maxRetries) {
    retryCount++;
    currentBitrate = Math.floor(currentBitrate * 0.8);
    onStatus?.(`再圧縮中... ( bitrate: ${currentBitrate}kbps ) [${retryCount}/${maxRetries}]`);
    addDebugLog('STEP', `再圧縮 ${retryCount}: bitrate=${currentBitrate}kbps`);
    try { ff.FS('unlink', outputName); } catch(e) {}
    result = await tryCompress(ff, inputName, outputName, currentBitrate, audioBitrateKbps);
    if (result) {
      compressedSize = result.length;
      addDebugLog('INFO', `再圧縮${retryCount}: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  // Step 3: 解像度ダウンスケール
  if (compressedSize > TARGET_SIZE_BYTES) {
    onStatus?.('解像度を下げて圧縮中...');
    addDebugLog('STEP', '解像度ダウンスケール開始');
    const scales = ['1280:-2', '960:-2', '640:-2', '480:-2'];
    for (const scale of scales) {
      try { ff.FS('unlink', outputName); } catch(e) {}
      onStatus?.(`解像度 ${scale.split(':')[0]}px で圧縮中...`);
      result = await tryCompressWithScale(ff, inputName, outputName, currentBitrate, audioBitrateKbps, scale);
      if (result && result.length <= TARGET_SIZE_BYTES) {
        compressedSize = result.length;
        addDebugLog('INFO', `${scale}で達成: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
        break;
      }
      if (result) compressedSize = result.length;
    }
  }

  // クリーンアップ
  try { ff.FS('unlink', inputName); } catch(e) {}
  try { ff.FS('unlink', outputName); } catch(e) {}

  if (!result) throw new Error('動画の圧縮に失敗しました');

  const blob = new Blob([result.buffer], { type: 'video/mp4' });
  addDebugLog('INFO', `圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

  return { blob, originalSize: file.size, compressedSize: blob.size };
}

// ============ ヘルパー ============

async function getVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration || 60);
    };
    video.onerror = () => resolve(60);
    video.src = URL.createObjectURL(file);
  });
}

async function tryCompress(ff, inputName, outputName, videoBitrate, audioBitrate) {
  try {
    addDebugLog('FFMPEG', `エンコード: -b:v ${videoBitrate}k -b:a ${audioBitrate}k`);
    await ff.run(
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
    );
    const data = ff.FS('readFile', outputName);
    // 出力サイズが異常に小さい場合はエラー扱い
    if (data.length < 1000) {
      addDebugLog('ERROR', `出力が小さすぎます (${data.length} bytes)。エンコーダが失敗した可能性。`);
      // 利用可能なエンコーダを確認
      addDebugLog('FFMPEG', '利用可能エンコーダ確認中...');
      try {
        await ff.run('-encoders', '-hide_banner');
      } catch(e) {}
      return null;
    }
    addDebugLog('FFMPEG', `完了: ${data.length} bytes`);
    return data;
  } catch (err) {
    addDebugLog('ERROR', `圧縮エラー: ${err.message || err}`);
    return null;
  }
}

async function tryCompressWithScale(ff, inputName, outputName, videoBitrate, audioBitrate, scale) {
  try {
    addDebugLog('FFMPEG', `エンコード(scale=${scale}): -b:v ${videoBitrate}k`);
    await ff.run(
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
    );
    const data = ff.FS('readFile', outputName);
    addDebugLog('FFMPEG', `完了: ${data.length} bytes`);
    return data;
  } catch (err) {
    addDebugLog('ERROR', `圧縮エラー: ${err.message || err}`);
    return null;
  }
}
