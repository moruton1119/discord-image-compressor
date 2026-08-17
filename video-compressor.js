/**
 * Discord 画像/動画 圧縮くん - 動画圧縮モジュール
 * 
 * 2つのエンジンを使い分け:
 * 1. WebCodecs API（爆速・ハードウェアアクセラレーション・推奨）
 * 2. Canvas + MediaRecorder（フォールバック・全環境対応）
 */

// Discordプラン別の上限（2026年8月時点の公式仕様）
// 無料: 20MB / Nitro Basic: 50MB / Nitro: 500MB
let TARGET_SIZE_MB = 20;
let TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;
let ACCEPT_SIZE_BYTES = 18 * 1024 * 1024; // 10%の安全マージン

function applyTargetSize(mb) {
  TARGET_SIZE_MB = mb;
  TARGET_SIZE_BYTES = mb * 1024 * 1024;
  ACCEPT_SIZE_BYTES = Math.floor(mb * 0.9) * 1024 * 1024;
}

// ============ キャンセル制御 ============
let cancelRequested = false;

export function requestCancel() {
  cancelRequested = true;
}

// 再圧縮の最大試行回数（1回目＋再試行2回＝計3回）
const MAX_ATTEMPTS = 3;
export const CANCEL_MESSAGE = 'キャンセルされました';

// ============ デバッグログ（パネル表示は廃止・consoleのみ） ============
function addDebugLog(level, message) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] [${level}] ${message}`;
  console.log(entry);
  // デバッグパネルへの表示は不要のためコメントアウト
  // const panel = document.getElementById('debugPanel');
  // if (panel) {
  //   const line = document.createElement('div');
  //   line.className = `debug-line debug-${level.toLowerCase()}`;
  //   line.textContent = entry;
  //   panel.appendChild(line);
  //   panel.scrollTop = panel.scrollHeight;
  // }
}

// ============ エンジン選択 ============
function getEngine() {
  if (typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined') {
    return 'webcodecs';
  }
  return 'mediarecorder';
}

// ============ 動画圧縮メイン ============

export async function compressVideo(file, onProgress, onStatus, targetSizeMB = 20) {
  // キャンセル状態をリセット
  cancelRequested = false;
  // プラン別の目標サイズを適用
  applyTargetSize(targetSizeMB);
  addDebugLog('INFO', `目標サイズ: ${TARGET_SIZE_MB}MB（プラン選択）`);

  addDebugLog('INFO', `動画圧縮開始: ${file.name}`);
  addDebugLog('INFO', `ファイルサイズ: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
  addDebugLog('INFO', `MIME Type: ${file.type}`);

  const engine = getEngine();
  addDebugLog('INFO', `エンジン: ${engine}`);

  // 動画メタデータ取得
  onStatus?.('動画情報を解析中...');
  const videoInfo = await getVideoInfo(file);
  addDebugLog('INFO', `解像度: ${videoInfo.width}x${videoInfo.height}`);
  addDebugLog('INFO', `動画の長さ: ${videoInfo.duration.toFixed(1)}秒`);
  addDebugLog('INFO', `フレームレート: ${videoInfo.fps}`);

  // 元ファイルが既に目標サイズ以下ならそのまま返す
  if (file.size <= TARGET_SIZE_BYTES) {
    addDebugLog('INFO', `元ファイルが${(file.size / 1024 / 1024).toFixed(2)}MB — ${TARGET_SIZE_MB}MB以下のため圧縮不要`);
    return { blob: file, originalSize: file.size, compressedSize: file.size };
  }

  // 目標ビットレート計算（ACCEPT_SIZE_BYTES基準＝18MB、安全マージン込み）
  const audioBitrate = 64000;
  const targetTotalBitrate = Math.floor((ACCEPT_SIZE_BYTES * 8) / videoInfo.duration);
  const targetVideoBitrate = Math.max(100000, targetTotalBitrate - audioBitrate);
  addDebugLog('INFO', `目標ビットレート: video=${(targetVideoBitrate / 1000).toFixed(0)}kbps`);

  // 解像度スケール（プラン別：無料は1280px、Basicは1920px、Nitroは元解像度維持）
  let maxResolution = 1280;
  if (TARGET_SIZE_MB >= 500) maxResolution = Infinity;
  else if (TARGET_SIZE_MB >= 50) maxResolution = 1920;
  let targetWidth = videoInfo.width;
  let targetHeight = videoInfo.height;
  if (targetWidth > maxResolution || targetHeight > maxResolution) {
    const scale = maxResolution / Math.max(targetWidth, targetHeight);
    targetWidth = Math.round(targetWidth * scale / 2) * 2;
    targetHeight = Math.round(targetHeight * scale / 2) * 2;
    addDebugLog('INFO', `解像度ダウンスケール: ${targetWidth}x${targetHeight}`);
  }

  if (engine === 'webcodecs') {
    try {
      return await compressWithWebCodecs(file, videoInfo, targetWidth, targetHeight, targetVideoBitrate, onProgress, onStatus, 0);
    } catch (err) {
      // キャンセル時はフォールバックしない
      if (cancelRequested || err.message === CANCEL_MESSAGE) throw err;
      addDebugLog('WARN', `WebCodecs失敗、MediaRecorderにフォールバック: ${err.message}`);
      // フォールバック
      return await compressWithMediaRecorder(file, videoInfo, targetWidth, targetHeight, targetVideoBitrate, audioBitrate, onProgress, onStatus, 0);
    }
  } else {
    return await compressWithMediaRecorder(file, videoInfo, targetWidth, targetHeight, targetVideoBitrate, audioBitrate, onProgress, onStatus, 0);
  }
}

// ============================================================
//  WebCodecs エンジン（爆速・ハードウェア）
// ============================================================

async function compressWithWebCodecs(file, videoInfo, targetWidth, targetHeight, videoBitrate, onProgress, onStatus, attempt = 0) {
  if (cancelRequested) throw new Error(CANCEL_MESSAGE);
  addDebugLog('LOAD', 'WebCodecs エンジン起動...');

  // Phase 1: ライブラリ読み込み (0〜5%)
  onStatus?.('MP4パーサーを読み込み中...');
  onProgress?.(2);
  const mp4boxModule = await import('./vendor/mp4box.all.mjs');
  window.MP4Box = mp4boxModule;
  addDebugLog('LOAD', 'mp4box.js 読み込みOK（同梱）');
  onProgress?.(4);

  await loadScript('./vendor/mp4-muxer.js');
  addDebugLog('LOAD', 'mp4-muxer 読み込みOK（同梱）');
  onProgress?.(5);

  // Phase 2: MP4デマックス (5〜15%)
  onStatus?.('動画を解析中...');
  onProgress?.(8);
  const { chunks, decoderConfig, videoTrack } = await demuxMP4(file);
  addDebugLog('INFO', `デマックス完了: ${chunks.length}チャンク, codec=${decoderConfig.codec}`);
  onProgress?.(15);

  // Step 2: デコーダ設定
  const supported = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!supported.supported) {
    throw new Error(`デコーダ非対応: ${decoderConfig.codec}`);
  }

  // Step 3: エンコーダ設定
  const encoderCodec = 'avc1.640028'; // H.264 High Profile Level 4.0
  const encoderConfig = {
    codec: encoderCodec,
    width: targetWidth,
    height: targetHeight,
    bitrate: videoBitrate,
    framerate: videoInfo.fps,
    bitrateMode: 'constant',  // CBRでサイズを確実に制御
  };
  const encSupported = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!encSupported.supported) {
    // 別のプロファイルを試す
    encoderConfig.codec = 'avc1.42001f'; // Baseline Level 3.1
    const encSupported2 = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!encSupported2.supported) {
      throw new Error('H.264エンコーダ非対応');
    }
  }
  addDebugLog('INFO', `エンコーダ設定: codec=${encoderConfig.codec}, ${targetWidth}x${targetHeight}, ${(videoBitrate / 1000).toFixed(0)}kbps`);
  onProgress?.(18);

  // Step 4: Muxer設定（mp4-muxer）
  // mp4-muxer.js は var Mp4Muxer でグローバルに展開される
  const muxerLib = window.Mp4Muxer || Mp4Muxer;
  const { Muxer, ArrayBufferTarget } = muxerLib;
  const muxerTarget = new ArrayBufferTarget();
  const muxer = new Muxer({
    target: muxerTarget,
    video: {
      codec: 'avc',
      width: targetWidth,
      height: targetHeight,
    },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  // Step 5: デコード → リサイズ → エンコード パイプライン
  onStatus?.('圧縮中...');
  onProgress?.(20);

  // Canvas for resizing
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { alpha: false });

  let encodedChunks = [];
  let frameIndex = 0;
  let decodedCount = 0;
  const totalChunks = chunks.length;

  return new Promise((resolve, reject) => {
    let decoder = null;
    let encoder = null;
    let pendingDecodes = 0;
    let allChunksSubmitted = false;
    let decodedFrameIndices = [];
    let encoderFinished = false;

    // エンコーダ
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer.addVideoChunk(chunk, meta);
        encodedChunks.push(chunk);
      },
      error: (e) => {
        addDebugLog('ERROR', `エンコードエラー: ${e.message}`);
        reject(e);
      },
    });
    encoder.configure(encoderConfig);

    // デコーダ
    decoder = new VideoDecoder({
      output: (frame) => {
        // キャンセルチェック
        if (cancelRequested) {
          frame.close();
          try { encoder.close(); } catch (e) {}
          try { decoder.close(); } catch (e) {}
          reject(new Error(CANCEL_MESSAGE));
          return;
        }

        const idx = decodedFrameIndices.shift();

        // Canvas経由でリサイズ
        if (targetWidth !== videoInfo.width || targetHeight !== videoInfo.height) {
          ctx.drawImage(frame, 0, 0, targetWidth, targetHeight);
          frame.close();
          const resizedFrame = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: frame.duration,
          });
          encoder.encode(resizedFrame, { keyFrame: idx % 60 === 0 });
          resizedFrame.close();
        } else {
          encoder.encode(frame, { keyFrame: idx % 60 === 0 });
          frame.close();
        }

        decodedCount++;
        pendingDecodes--;

        // フレーム処理の進捗: 20%〜90%をマッピング
        const frameProgress = 20 + (decodedCount / totalChunks * 70);
        onProgress?.(frameProgress);

        if (decodedCount === totalChunks) {
          onProgress?.(90);
          addDebugLog('STEP', `全${totalChunks}フレーム処理完了`);
        }

        // すべてのチャンクを処理し終えたらエンコーダをフラッシュ
        if (allChunksSubmitted && pendingDecodes === 0) {
          if (!encoderFinished) {
            encoderFinished = true;
            onProgress?.(93);
            encoder.flush().then(() => {
              encoder.close();
              decoder.close();
              onProgress?.(96);
              muxer.finalize();
              onProgress?.(99);

              const blob = new Blob([muxerTarget.buffer], { type: 'video/mp4' });
              addDebugLog('INFO', `WebCodecs圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);
              onProgress?.(100);

              if (blob.size > TARGET_SIZE_BYTES) {
                // キャンセルチェック
                if (cancelRequested) { reject(new Error(CANCEL_MESSAGE)); return; }
                // 試行回数上限
                if (attempt + 1 >= MAX_ATTEMPTS) {
                  addDebugLog('WARN', `${MAX_ATTEMPTS}回試行したが${TARGET_SIZE_MB}MB未達。最終結果を妥協案として返却`);
                  resolve({ blob, originalSize: file.size, compressedSize: blob.size, degraded: true });
                  return;
                }
                addDebugLog('WARN', `サイズ超過 (${(blob.size / 1024 / 1024).toFixed(2)}MB > ${TARGET_SIZE_MB}MB)。実測から逆算して再圧縮...`);
                // 実測オーバー率から逆算（0.95は安全係数）
                const overshootRatio = blob.size / ACCEPT_SIZE_BYTES;
                const lowerBitrate = Math.max(50000, Math.floor(videoBitrate * 0.95 / overshootRatio));
                const smallerWidth = Math.max(320, Math.round(targetWidth * 0.75 / 2) * 2);
                const smallerHeight = Math.max(240, Math.round(targetHeight * 0.75 / 2) * 2);
                onStatus?.(`品質を調整中... (${attempt + 2}/${MAX_ATTEMPTS}回目)`);
                compressWithWebCodecs(file, videoInfo, smallerWidth, smallerHeight, lowerBitrate, onProgress, onStatus, attempt + 1)
                  .then(resolve).catch(reject);
              } else {
                resolve({ blob, originalSize: file.size, compressedSize: blob.size });
              }
            }).catch(reject);
          }
        }
      },
      error: (e) => {
        addDebugLog('ERROR', `デコードエラー: ${e.message}`);
        reject(e);
      },
    });
    decoder.configure(decoderConfig);

    // チャンクを順次デコード（バックプレッシャー制御）
    async function feedChunks() {
      for (let i = 0; i < chunks.length; i++) {
        if (cancelRequested) throw new Error(CANCEL_MESSAGE);
        // デコーダのキューが溜まりすぎたら待つ
        while (decoder.decodeQueueSize > 15) {
          if (cancelRequested) throw new Error(CANCEL_MESSAGE);
          await new Promise(r => setTimeout(r, 5));
        }
        // エンコーダのキューもチェック
        while (encoder.encodeQueueSize > 15) {
          await new Promise(r => setTimeout(r, 5));
        }

        decodedFrameIndices.push(i);
        decoder.decode(chunks[i]);
        pendingDecodes++;
      }
      allChunksSubmitted = true;
      // デコーダの残りをフラッシュ
      await decoder.flush();
    }

    feedChunks().catch(reject);
  });
}

// ============ MP4 デマックス（mp4box.js） ============

async function demuxMP4(file) {
  return new Promise((resolve, reject) => {
    const mp4box = window.MP4Box.createFile();
    const chunks = [];
    let decoderConfig = null;
    let videoTrack = null;
    let lastSampleStartTime = 0;

    mp4box.onError = (e) => reject(new Error(`mp4box error: ${e}`));

    mp4box.onReady = (info) => {
      addDebugLog('LOAD', `MP4情報: ${info.videoTracks?.length || 0}映像トラック, ${info.audioTracks?.length || 0}音声トラック`);
      
      if (!info.videoTracks || info.videoTracks.length === 0) {
        reject(new Error('映像トラックが見つかりません'));
        return;
      }

      videoTrack = info.videoTracks[0];
      addDebugLog('INFO', `映像: ${videoTrack.video.width}x${videoTrack.video.height}, codec=${videoTrack.codec}`);

      // デコーダ設定を準備
      mp4box.setExtractionOptions(videoTrack.id, null, {
        nbSamples: 100,
      });

      // description取得（W3C公式方法: file.getTrackByIdを使用）
      const description = getDecoderDescription(mp4box, videoTrack);
      addDebugLog('LOAD', `description取得結果(onReady): ${description ? `${description.length}bytes` : 'null'}`);
      decoderConfig = {
        codec: videoTrack.codec.startsWith('vp08') ? 'vp8' : videoTrack.codec,
        codedWidth: videoTrack.track_width,
        codedHeight: videoTrack.track_height,
      };
      if (description) {
        decoderConfig.description = description;
      }

      // デコーダはonSamplesでdescription取得後に設定
      mp4box.start();
    };

    mp4box.onSamples = (trackId, ref, samples) => {
      let firstKeyFound = chunks.length > 0;

      for (const sample of samples) {
        // 最初のキーフレームが来るまでスキップ（デコーダ初期化に必要）
        if (!firstKeyFound) {
          if (!sample.is_sync) {
            addDebugLog('LOAD', '最初のキーフレームを待機中...');
            continue;
          }
          firstKeyFound = true;
          addDebugLog('LOAD', '最初のキーフレーム取得');
        }

        const chunk = new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: sample.cts * 1000000 / sample.timescale,
          duration: sample.duration * 1000000 / sample.timescale,
          data: sample.data,
        });
        chunks.push(chunk);
      }

      // 全サンプル抽出完了チェック
      if (samples.length === 0 || chunks.length >= videoTrack.nb_samples) {
        mp4box.stop();
        resolve({ chunks, decoderConfig, videoTrack });
      }
    };

    // ファイルを読み込んでmp4boxに渡す
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result;
      // ArrayBufferにuser-providedプロパティを設定（mp4box要件）
      buffer.fileStart = 0;
      mp4box.appendBuffer(buffer);
      mp4box.flush();
    };
    reader.onerror = () => reject(new Error('ファイル読み込みエラー'));
    reader.readAsArrayBuffer(file);
  });
}

// decoder description — W3C公式サンプルと同じ方法
// file.getTrackById() で内部trackオブジェクトを取得し、
// avcC/hvcC/vpcC/av1C ボックスをシリアライズして先頭8バイトを削る
function getDecoderDescription(file, track) {
  const trak = file.getTrackById(track.id);
  if (!trak || !trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl || !trak.mdia.minf.stbl.stsd) {
    addDebugLog('WARN', `description: trak取得失敗`);
    return undefined;
  }
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new window.MP4Box.DataStream(undefined, 0, window.MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream);
      const description = new Uint8Array(stream.buffer, 8); // ボックスヘッダー(8バイト)を削除
      addDebugLog('LOAD', `description取得OK: ${box.box_name || 'unknown'} (${description.length}bytes)`);
      return description;
    }
  }
  addDebugLog('WARN', 'avcC/hvcC/vpcC/av1C boxが見つかりません');
  return undefined;
}

// ============ MediaRecorder エンジン（フォールバック） ============

async function compressWithMediaRecorder(file, videoInfo, targetWidth, targetHeight, videoBitrate, audioBitrate, onProgress, onStatus, attempt = 0) {
  if (cancelRequested) throw new Error(CANCEL_MESSAGE);
  addDebugLog('LOAD', 'MediaRecorder エンジン起動（フォールバック）...');

  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = true;   // 音を出さない
  video.playsInline = true;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('動画の読み込みに失敗'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { alpha: false });

  const audioCtx = new AudioContext();
  const sourceNode = audioCtx.createMediaElementSource(video);
  const canvasStream = canvas.captureStream(videoInfo.fps);
  const audioDestination = audioCtx.createMediaStreamDestination();
  sourceNode.connect(audioDestination);  // 録画用のみに接続
  // audioCtx.destination には繋がない → 音を出さない

  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks(),
  ]);

  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  let mimeType = '';
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) {
      mimeType = mt;
      break;
    }
  }
  if (!mimeType) throw new Error('対応する動画エンコーダが見つかりません');

  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: videoBitrate,
    audioBitsPerSecond: audioBitrate,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  onStatus?.('圧縮中... (MediaRecorder)');
  onProgress?.(15);
  recorder.start(100);

  video.currentTime = 0;
  // 再生速度を上げて処理時間を短縮（音は出ないから問題なし）
  video.playbackRate = Math.min(4, videoInfo.duration > 60 ? 4 : 2);
  await video.play();
  addDebugLog('STEP', `録画開始（${video.playbackRate}倍速）`);

  const startTime = performance.now();
  let frameCount = 0;

  function drawFrame() {
    // キャンセルチェック
    if (cancelRequested) {
      video.pause();
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }
    if (video.ended || recorder.state === 'inactive') return;
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    frameCount++;
    const elapsed = (performance.now() - startTime) / 1000;
    const expectedDuration = videoInfo.duration / video.playbackRate;
    // 15%〜95%をマッピング
    const progress = 15 + Math.min(elapsed / expectedDuration, 1) * 80;
    onProgress?.(progress);
    if (frameCount % 300 === 0) {
      addDebugLog('STEP', `${elapsed.toFixed(1)}s / ${expectedDuration.toFixed(1)}s expected (${progress.toFixed(0)}%)`);
    }
    requestAnimationFrame(drawFrame);
  }
  requestAnimationFrame(drawFrame);

  await new Promise((resolve) => {
    recorder.onstop = () => resolve();
    video.onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
  });

  URL.revokeObjectURL(video.src);
  audioCtx.close();

  // キャンセルされていたらここで中断
  if (cancelRequested) throw new Error(CANCEL_MESSAGE);

  const blob = new Blob(chunks, { type: mimeType });
  onProgress?.(100);
  addDebugLog('INFO', `MediaRecorder圧縮完了: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

  if (blob.size > TARGET_SIZE_BYTES) {
    // 試行回数上限
    if (attempt + 1 >= MAX_ATTEMPTS) {
      addDebugLog('WARN', `${MAX_ATTEMPTS}回試行したが${TARGET_SIZE_MB}MB未達。最終結果を妥協案として返却`);
      return { blob, originalSize: file.size, compressedSize: blob.size, degraded: true };
    }
    addDebugLog('WARN', `サイズ超過 (${(blob.size / 1024 / 1024).toFixed(2)}MB > ${TARGET_SIZE_MB}MB)。実測から逆算して再圧縮...`);
    // 実測オーバー率から逆算（0.95は安全係数）
    const overshootRatio = blob.size / ACCEPT_SIZE_BYTES;
    const lowerBitrate = Math.max(50000, Math.floor(videoBitrate * 0.95 / overshootRatio));
    const smallerWidth = Math.max(320, Math.round(targetWidth * 0.75 / 2) * 2);
    const smallerHeight = Math.max(240, Math.round(targetHeight * 0.75 / 2) * 2);
    onStatus?.(`品質を調整中... (${attempt + 2}/${MAX_ATTEMPTS}回目)`);
    return await compressWithMediaRecorder(file, videoInfo, smallerWidth, smallerHeight, lowerBitrate, audioBitrate, onProgress, onStatus, attempt + 1);
  }

  return { blob, originalSize: file.size, compressedSize: blob.size };
}

// ============ ヘルパー ============

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`スクリプト読み込み失敗: ${src}`));
    document.head.appendChild(script);
  });
}

async function getVideoInfo(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        fps: 30,
      });
    };
    video.onerror = () => reject(new Error('動画メタデータの取得に失敗'));
    video.src = URL.createObjectURL(file);
  });
}
