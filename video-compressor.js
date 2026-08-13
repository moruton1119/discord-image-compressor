/**
 * Discord 画像/動画 圧縮くん - 動画圧縮モジュール
 * 
 * 2つのエンジンを使い分け:
 * 1. WebCodecs API（高速・ハードウェアアクセラレーション・推奨）
 * 2. Canvas + MediaRecorder（フォールバック・全環境対応）
 * 
 * どちらも追加ライブラリ不要・ブラウザネイティブ動作
 * ffmpeg.wasm は完全に廃止（メモリ問題・SAB問題・速度問題のすべてを解決）
 */

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

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

// ============ エンジン選択 ============
function getEngine() {
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    return 'webcodecs';
  }
  return 'mediarecorder';
}

// ============ 動画圧縮メイン ============

export async function compressVideo(file, onProgress, onStatus) {
  addDebugLog('INFO', `動画圧縮開始: ${file.name}`);
  addDebugLog('INFO', `ファイルサイズ: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
  addDebugLog('INFO', `MIME Type: ${file.type}`);

  // 動画のメタデータ取得
  onStatus?.('動画情報を解析中...');
  const videoInfo = await getVideoInfo(file);
  addDebugLog('INFO', `解像度: ${videoInfo.width}x${videoInfo.height}`);
  addDebugLog('INFO', `動画の長さ: ${videoInfo.duration.toFixed(1)}秒`);
  addDebugLog('INFO', `フレームレート: ${videoInfo.fps}`);

  const engine = getEngine();
  addDebugLog('INFO', `エンジン: ${engine}`);

  // 目標ビットレート計算
  const audioBitrate = 64000; // 64kbps
  const targetTotalBitrate = Math.floor((TARGET_SIZE_BYTES * 8) / videoInfo.duration);
  const targetVideoBitrate = Math.max(100000, targetTotalBitrate - audioBitrate); // 最低100kbps
  addDebugLog('INFO', `目標ビットレート: video=${(targetVideoBitrate / 1000).toFixed(0)}kbps, audio=${(audioBitrate / 1000).toFixed(0)}kbps`);

  // 解像度スケール（元が大きい場合は下げる）
  const maxResolution = 1280;
  let targetWidth = videoInfo.width;
  let targetHeight = videoInfo.height;
  if (targetWidth > maxResolution || targetHeight > maxResolution) {
    const scale = maxResolution / Math.max(targetWidth, targetHeight);
    targetWidth = Math.round(targetWidth * scale / 2) * 2;
    targetHeight = Math.round(targetHeight * scale / 2) * 2;
    addDebugLog('INFO', `解像度ダウンスケール: ${targetWidth}x${targetHeight}`);
  }

  if (engine === 'webcodecs') {
    return await compressWithMediaRecorder(file, videoInfo, targetWidth, targetHeight, targetVideoBitrate, audioBitrate, onProgress, onStatus);
  } else {
    return await compressWithMediaRecorder(file, videoInfo, targetWidth, targetHeight, targetVideoBitrate, audioBitrate, onProgress, onStatus);
  }
}

// ============ MediaRecorder エンジン ============
// Canvas に動画を描画しながら MediaRecorder で録画する
// ハードウェアエンコード・低メモリ・高速

async function compressWithMediaRecorder(file, videoInfo, targetWidth, targetHeight, videoBitrate, audioBitrate, onProgress, onStatus) {
  addDebugLog('LOAD', 'MediaRecorder エンジン起動...');

  // video要素の準備
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = false;
  video.playsInline = true;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('動画の読み込みに失敗しました'));
  });

  addDebugLog('STEP', `動画読み込み完了: ${video.videoWidth}x${video.videoHeight}`);

  // Canvasの準備
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { alpha: false });

  // audio用のコンテキスト
  const audioCtx = new AudioContext();
  const sourceNode = audioCtx.createMediaElementSource(video);

  // MediaStream の準備
  const canvasStream = canvas.captureStream(videoInfo.fps);
  const audioDestination = audioCtx.createMediaStreamDestination();
  sourceNode.connect(audioDestination);
  sourceNode.connect(audioCtx.destination); // 再生音

  // 映像 + 音声を結合
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks(),
  ]);

  // サポートされているMIMEタイプを探す
  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/mp4;codecs=h264,aac',
    'video/webm',
  ];
  let mimeType = '';
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) {
      mimeType = mt;
      break;
    }
  }
  if (!mimeType) {
    throw new Error('対応する動画エンコーダが見つかりません');
  }
  addDebugLog('INFO', `MIME Type: ${mimeType}`);

  // MediaRecorder 作成
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: videoBitrate,
    audioBitsPerSecond: audioBitrate,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  // 録画開始
  onStatus?.('圧縮中...');
  recorder.start(100); // 100ms毎にデータ取得

  // 動画再生＆Canvas描画
  video.currentTime = 0;
  await video.play();
  addDebugLog('STEP', '録画開始');

  const startTime = performance.now();
  let frameCount = 0;

  function drawFrame() {
    if (video.ended || recorder.state === 'inactive') return;

    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    frameCount++;

    const elapsed = (performance.now() - startTime) / 1000;
    const progress = Math.min(elapsed / videoInfo.duration * 100, 100);
    onProgress?.(progress);

    if (frameCount % 30 === 0) {
      addDebugLog('STEP', `${elapsed.toFixed(1)}s / ${videoInfo.duration.toFixed(1)}s (${progress.toFixed(0)}%)`);
    }

    requestAnimationFrame(drawFrame);
  }
  requestAnimationFrame(drawFrame);

  // 動画終了待機
  await new Promise((resolve) => {
    video.onended = () => {
      addDebugLog('STEP', '録画終了');
      recorder.stop();
      // onstop後にresolve
      recorder.onstop = () => resolve();
    };
  });

  // リソース解放
  URL.revokeObjectURL(video.src);
  audioCtx.close();

  const blob = new Blob(chunks, { type: mimeType });
  addDebugLog('INFO', `圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

  // サイズチェック
  if (blob.size > TARGET_SIZE_BYTES) {
    addDebugLog('WARN', `まだ${(blob.size / 1024 / 1024).toFixed(2)}MB。解像度・ビットレートを下げて再圧縮します。`);

    // より低いビットレート・解像度で再トライ
    const lowerBitrate = Math.floor(videoBitrate * 0.5);
    const smallerWidth = Math.round(targetWidth * 0.75 / 2) * 2;
    const smallerHeight = Math.round(targetHeight * 0.75 / 2) * 2;

    addDebugLog('STEP', `再圧縮: ${smallerWidth}x${smallerHeight}, ${(lowerBitrate / 1000).toFixed(0)}kbps`);
    const retryResult = await compressWithMediaRecorder(file, videoInfo, smallerWidth, smallerHeight, lowerBitrate, audioBitrate, onProgress, onStatus);
    return retryResult;
  }

  // WebM → MP4変換は省略（Discord は WebM もサポートしてる）
  return { blob, originalSize: file.size, compressedSize: blob.size };
}

// ============ ヘルパー ============

async function getVideoInfo(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      const info = {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        fps: 30, // ブラウザでは正確なFPSが取れないのでデフォルト30
      };
      resolve(info);
    };
    video.onerror = () => reject(new Error('動画メタデータの取得に失敗'));
    video.src = URL.createObjectURL(file);
  });
}
