/**
 * Discord 圧縮くん — 統合エントリーポイント
 * 画像圧縮（Rust/WASM）と動画圧縮（ffmpeg.wasm）を統合
 */

// ===== タブ切り替え =====
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${target}Tab`).classList.add('active');
  });
});

// ===== 共通DOM要素 =====
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const processingOverlay = document.getElementById('processingOverlay');
const processingText = document.getElementById('processingText');
const processingSubtext = document.getElementById('processingSubtext');
const fileCounter = document.getElementById('fileCounter');

let isProcessing = false;

// ============================================================
//  画像圧縮（Rust/WASM）
// ============================================================

// ===== Discordプラン管理 =====
// 無料: 20MB / Nitro Basic: 50MB / Nitro: 500MB（2026年8月時点の公式仕様）
const PLAN_LIMITS = { 'free': 20, 'basic': 50, 'nitro': 500 };

function getPlanMB() {
  const planSelect = document.getElementById('planSelect');
  return PLAN_LIMITS[planSelect?.value] || 20;
}

function getImageTargetBytes() {
  return getPlanMB() * 1024 * 1024;
}

function updateTargetSizeDisplay() {
  const mb = getPlanMB();
  document.querySelectorAll('.target-size').forEach(el => {
    el.textContent = `${mb} MB`;
  });
}

document.getElementById('planSelect')?.addEventListener('change', updateTargetSizeDisplay);
updateTargetSizeDisplay();

let wasmReady = false;
let compressor = null;

let wasmInitError = null;

async function ensureWasm() {
  if (wasmReady) return;
  if (wasmInitError) throw wasmInitError;
  try {
    const wasmModule = await import('./image_compressor.js');
    const init = wasmModule.default;
    if (typeof init !== 'function') {
      throw new Error(`init関数が見つかりません。default=${typeof wasmModule.default}, keys=${Object.keys(wasmModule).join(',')}`);
    }
    await init({ module_or_path: './image_compressor_bg.wasm' });
    compressor = new wasmModule.ImageCompressor();
    wasmReady = true;
    console.log('🦀 Rust/WASM エンジン初期化完了!');
  } catch (err) {
    wasmInitError = err;
    console.error('WASM初期化エラー:', err);
    throw err;
  }
}

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const results = document.getElementById('results');
const formatSelect = document.getElementById('formatSelect');

uploadArea.addEventListener('click', () => { if (!isProcessing) fileInput.click(); });
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); if (!isProcessing) uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('dragover'); if (!isProcessing) handleImages(e.dataTransfer.files); });
fileInput.addEventListener('change', (e) => { if (!isProcessing) handleImages(e.target.files); });

// WASM初期化（非同期・エラーでもアプリは動く）
ensureWasm().catch(err => {
  console.error('WASM初期化エラー（画像圧縮は使用不可）:', err);
});

async function handleImages(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) { alert('画像ファイルをアップロードしてください'); return; }
  await ensureWasm();

  isProcessing = true;
  uploadArea.classList.add('processing');
  processingOverlay.classList.add('active');
  progressBar.classList.add('active');

  for (let i = 0; i < imageFiles.length; i++) {
    updateProgress((i / imageFiles.length) * 100);
    processingText.textContent = '🦀 Rust/WASM で圧縮処理中...';
    processingSubtext.textContent = truncate(imageFiles[i].name, 50);
    fileCounter.textContent = `${i + 1} / ${imageFiles.length} 枚目`;
    try {
      const result = await compressImageWasm(imageFiles[i]);
      addImageResult(imageFiles[i], result);
    } catch (err) { addErrorCard(results, imageFiles[i], err.message); }
  }

  finishProcessing();
}

async function compressImageWasm(file) {
  // 元ファイルが既に目標サイズ以下ならそのまま返す
  const imageTargetBytes = getImageTargetBytes();
  if (file.size <= imageTargetBytes) {
    return { blob: file, isLossless: true };
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const format = formatSelect.value;
  const info = compressor.get_image_info(data);

  let blob;

  const compressed = compressor.compress_to_target_size(data, imageTargetBytes);
  if (compressed.length === 0) throw new Error('圧縮に失敗しました');
  blob = new Blob([compressed], { type: 'image/jpeg' });
  return { blob, isLossless: false };
}

function addImageResult(file, result) {
  const previewUrl = URL.createObjectURL(result.blob);
  const originalMB = (file.size / 1048576).toFixed(2);
  const compressedMB = (result.blob.size / 1048576).toFixed(2);
  const ratio = ((1 - result.blob.size / file.size) * 100).toFixed(1);
  const engine = result.isLossless ? 'WebP Lossless' : 'JPEG (Rust/WASM)';
  addResultCard(results, file.name, previewUrl, originalMB, compressedMB, ratio, engine, 'webp', 'jpg');
}

// ============================================================
//  動画圧縮（ffmpeg.wasm）
// ============================================================
const videoUploadArea = document.getElementById('videoUploadArea');
const videoInput = document.getElementById('videoInput');
const videoResults = document.getElementById('videoResults');

// ===== キャンセル制御 =====
const cancelBtn = document.getElementById('cancelBtn');
let videoCompressorModule = null;

cancelBtn.addEventListener('click', () => {
  if (!videoCompressorModule) return;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'キャンセル中...';
  videoCompressorModule.requestCancel();
});

function resetCancelButton() {
  cancelBtn.disabled = false;
  cancelBtn.textContent = '✕ キャンセル';
}

videoUploadArea.addEventListener('click', () => {
  console.log('[VIDEO] 動画エリアクリック');
  if (!isProcessing) videoInput.click();
});
videoUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); if (!isProcessing) videoUploadArea.classList.add('dragover'); });
videoUploadArea.addEventListener('dragleave', () => videoUploadArea.classList.remove('dragover'));
videoUploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  videoUploadArea.classList.remove('dragover');
  console.log('[VIDEO] ドロップ検知:', e.dataTransfer.files.length, 'ファイル');
  if (!isProcessing && e.dataTransfer.files.length > 0) handleVideo(e.dataTransfer.files[0]);
});
videoInput.addEventListener('change', (e) => {
  console.log('[VIDEO] ファイル選択:', e.target.files.length, 'ファイル');
  if (!isProcessing && e.target.files.length > 0) handleVideo(e.target.files[0]);
});

async function handleVideo(file) {
  console.log('[VIDEO] handleVideo:', file.name, 'type=', file.type, 'size=', (file.size/1048576).toFixed(2), 'MB');
  // デバッグパネルへの出力は廃止（ログ不要のため）
  // const dp = document.getElementById('debugPanel');
  // if (dp) {
  //   const t = new Date().toLocaleTimeString();
  //   const line = document.createElement('div');
  //   line.className = 'debug-line debug-load';
  //   line.textContent = `[${t}] [VIDEO] ファイル受付: ${file.name} (${(file.size/1048576).toFixed(2)}MB)`;
  //   dp.appendChild(line);
  // }
  if (!file.type.startsWith('video/')) {
    console.error('[VIDEO] 動画ではない:', file.type);
    alert('動画ファイルをアップロードしてください');
    return;
  }

  isProcessing = true;
  videoUploadArea.classList.add('processing');
  processingOverlay.classList.add('active');
  progressBar.classList.add('active');

  try {
    // ffmpeg.wasm を動的インポート（初回のみロード）
    processingText.textContent = '🎬 ffmpeg.wasm を読み込み中...';
    processingSubtext.textContent = '初回は数秒かかります';
    fileCounter.textContent = '';

    console.log('[VIDEO] video-compressor.js を動的インポート中...');
    // デバッグパネルへの出力は廃止
    // const dp = document.getElementById('debugPanel');
    // if (dp) {
    //   const t = new Date().toLocaleTimeString();
    //   const line = document.createElement('div');
    //   line.className = 'debug-line debug-load';
    //   line.textContent = `[${t}] [LOAD] video-compressor.js をインポート中...`;
    //   dp.appendChild(line);
    // }

    const mod = await import('./video-compressor.js');
    videoCompressorModule = mod;
    const { compressVideo } = mod;
    console.log('[VIDEO] イポート完了、圧縮開始...');

    const result = await compressVideo(
      file,
      (percent) => updateProgress(percent),
      (status) => { processingText.textContent = '🎬 動画圧縮中...'; processingSubtext.textContent = status; },
      getPlanMB()
    );

    addVideoResult(file, result);
  } catch (err) {
    console.error('動画圧縮エラー:', err);
    // デバッグパネルへのエラー表示は廃止
    // const dp = document.getElementById('debugPanel');
    // if (dp) {
    //   const t = new Date().toLocaleTimeString();
    //   const line = document.createElement('div');
    //   line.className = 'debug-line debug-error';
    //   line.textContent = `[${t}] [ERROR] 動画圧縮失敗: ${err.message || err}\nStack: ${err.stack || 'no stack'}`;
    //   dp.appendChild(line);
    // }
    // キャンセルの場合はエラーカードを出さない
    if (err && err.message === 'キャンセルされました') {
      console.log('[VIDEO] ユーザーによりキャンセルされました');
    } else {
      addErrorCard(videoResults, file, err.message);
    }
  }

  finishProcessing();
  resetCancelButton();
  videoInput.value = '';
}

function addVideoResult(file, result) {
  const card = document.createElement('div');
  card.className = 'result-card';
  if (result.degraded) {
    card.style.borderColor = '#faa61a';
    card.style.background = 'rgba(250, 166, 26, 0.08)';
  }

  const previewUrl = URL.createObjectURL(result.blob);
  const originalMB = (result.originalSize / 1048576).toFixed(2);
  const compressedMB = (result.compressedSize / 1048576).toFixed(2);
  const ratio = ((1 - result.compressedSize / result.originalSize) * 100).toFixed(1);

  card.innerHTML = `
    <video class="video-preview" src="${previewUrl}" muted></video>
    <div class="info">
      <div class="filename">${escapeHtml(file.name)}</div>
      <div class="stats">
        <span class="stat before">📐 ${originalMB} MB</span>
        <span class="stat after">📦 ${compressedMB} MB</span>
        <span class="stat ratio">⚡ ${ratio}% 圧縮</span>
        ${result.degraded
          ? '<span class="stat" style="color:#faa61a;">⚠️ 目標超過（3回試行・妥協品質）</span>'
          : '<span class="stat">🎬 WebCodecs</span>'}
      </div>
      ${result.degraded
        ? '<div style="color:#faa61a; font-size:0.78rem; margin-top:6px;">💡 動画が長すぎて目標サイズ未達です。妥協案としてダウンロードできますが、送信先で弾かれる可能性があります。</div>'
        : ''}
    </div>
    <button class="download-btn">⬇️ ダウンロード</button>
  `;

  const downloadBtn = card.querySelector('.download-btn');
  const baseName = file.name.replace(/\.[^.]+$/, '');
  downloadBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = previewUrl;
    // 実際のコンテナ形式に合わせた拡張子（WebMが出力なら.webm）
    const ext = (result.blob.type || '').includes('webm') ? 'webm' : 'mp4';
    a.download = `${baseName}_compressed.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // プレビュー動画の最初のフレームを表示
  const video = card.querySelector('video');
  video.addEventListener('loadeddata', () => { video.currentTime = 0.1; });

  videoResults.prepend(card);
}

// ============================================================
//  共通ヘルパー
// ============================================================
function updateProgress(percent) {
  progressFill.style.width = `${Math.min(percent, 100)}%`;
  const percentElement = document.getElementById('progressPercent');
  if (percentElement) {
    percentElement.textContent = `${Math.round(percent)}%`;
  }
}

function finishProcessing() {
  updateProgress(100);
  setTimeout(() => {
    progressBar.classList.remove('active');
    progressFill.style.width = '0%';
    uploadArea.classList.remove('processing');
    videoUploadArea.classList.remove('processing');
    processingOverlay.classList.remove('active');
    isProcessing = false;
    fileInput.value = '';
  }, 500);
}

function addResultCard(container, filename, previewUrl, originalMB, compressedMB, ratio, engine, ext1, ext2) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <img class="preview" src="${previewUrl}" alt="プレビュー">
    <div class="info">
      <div class="filename">${escapeHtml(filename)}</div>
      <div class="stats">
        <span class="stat before">📐 ${originalMB} MB</span>
        <span class="stat after">📦 ${compressedMB} MB</span>
        <span class="stat ratio">⚡ ${ratio}% 圧縮</span>
        <span class="stat">🦀 ${engine}</span>
      </div>
    </div>
    <button class="download-btn">⬇️ ダウンロード</button>
  `;
  const downloadBtn = card.querySelector('.download-btn');
  const baseName = filename.replace(/\.[^.]+$/, '');
  const ext = engine.includes('WebP') ? ext1 : ext2;
  downloadBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = `${baseName}_compressed.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
  container.prepend(card);
}

function addErrorCard(container, file, errorMessage) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.style.borderColor = '#f04747';
  card.innerHTML = `
    <div class="preview" style="display:flex;align-items:center;justify-content:center;font-size:2rem;">❌</div>
    <div class="info">
      <div class="filename">${escapeHtml(file.name)}</div>
      <div class="stats"><span class="stat" style="color:#f04747;">エラー: ${escapeHtml(errorMessage)}</span></div>
    </div>
  `;
  container.prepend(card);
}

function truncate(str, maxLen) {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + '...';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 画面外ドロップ無効化
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ===== デバッグパネル（廃止：ログ表示不要のため） =====
// const debugToggle = document.getElementById('debugToggle');
// const debugPanel = document.getElementById('debugPanel');
// const debugCopyBtn = document.getElementById('debugCopyBtn');

// debugToggle.addEventListener('click', () => {
//   debugPanel.classList.toggle('active');
// });

// debugCopyBtn.addEventListener('click', async () => {
//   const logs = debugPanel.innerText || 'ログなし';
//   try {
//     await navigator.clipboard.writeText(logs);
//     debugCopyBtn.textContent = '✅ コピーしました!';
//   } catch (e) {
//     // フォールバック: テキストエリアを表示して手動コピー
//     const ta = document.createElement('textarea');
//     ta.value = logs;
//     ta.style.position = 'fixed';
//     ta.style.top = '0';
//     ta.style.left = '0';
//     ta.style.width = '100%';
//     ta.style.height = '300px';
//     ta.style.fontSize = '12px';
//     ta.style.zIndex = '99999';
//     document.body.appendChild(ta);
//     ta.select();
//     document.execCommand('copy');
//     document.body.removeChild(ta);
//     debugCopyBtn.textContent = '✅ コピーしました!';
//   }
//   setTimeout(() => { debugCopyBtn.textContent = '📋 ログをすべてコピー'; }, 2000);
// });

// ブラウザ情報の初期ログ出力（廃止）
// function logBrowserInfo() {
//   const lines = [];
//   lines.push(`UA: ${navigator.userAgent}`);
//   lines.push(`Platform: ${navigator.platform}`);
//   lines.push(`WebAssembly: ${typeof WebAssembly !== 'undefined' ? '✅' : '❌'}`);
//   lines.push(`Device Memory: ${navigator.deviceMemory || 'unknown'} GB`);
//   lines.push(`Hardware Concurrency: ${navigator.hardwareConcurrency || 'unknown'} cores`);
//   console.log(lines.join('\n'));
// }
// logBrowserInfo();
