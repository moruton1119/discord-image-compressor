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
import init, { ImageCompressor } from './image_compressor.js';

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

let wasmReady = false;
let compressor = null;

async function ensureWasm() {
  if (!wasmReady) {
    await init('./image_compressor_bg.wasm');
    compressor = new ImageCompressor();
    wasmReady = true;
    console.log('🦀 Rust/WASM エンジン初期化完了!');
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

ensureWasm().catch(err => console.error('WASM初期化エラー:', err));

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
  const data = new Uint8Array(await file.arrayBuffer());
  const format = formatSelect.value;
  const info = compressor.get_image_info(data);

  let blob;
  if (format === 'png') {
    const compressed = compressor.compress_webp_lossless(data);
    blob = new Blob([compressed], { type: 'image/webp' });
    return { blob, isLossless: true };
  }

  const compressed = compressor.compress_to_target_size(data, TARGET_SIZE_BYTES);
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

videoUploadArea.addEventListener('click', () => { if (!isProcessing) videoInput.click(); });
videoUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); if (!isProcessing) videoUploadArea.classList.add('dragover'); });
videoUploadArea.addEventListener('dragleave', () => videoUploadArea.classList.remove('dragover'));
videoUploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  videoUploadArea.classList.remove('dragover');
  if (!isProcessing && e.dataTransfer.files.length > 0) handleVideo(e.dataTransfer.files[0]);
});
videoInput.addEventListener('change', (e) => { if (!isProcessing && e.target.files.length > 0) handleVideo(e.target.files[0]); });

async function handleVideo(file) {
  if (!file.type.startsWith('video/')) { alert('動画ファイルをアップロードしてください'); return; }

  isProcessing = true;
  videoUploadArea.classList.add('processing');
  processingOverlay.classList.add('active');
  progressBar.classList.add('active');

  try {
    // ffmpeg.wasm を動的インポート（初回のみロード）
    processingText.textContent = '🎬 ffmpeg.wasm を読み込み中...';
    processingSubtext.textContent = '初回は数秒かかります';
    fileCounter.textContent = '';

    const { compressVideo } = await import('./video-compressor.js');

    const result = await compressVideo(
      file,
      (percent) => updateProgress(percent),
      (status) => { processingText.textContent = '🎬 動画圧縮中...'; processingSubtext.textContent = status; }
    );

    addVideoResult(file, result);
  } catch (err) {
    console.error('動画圧縮エラー:', err);
    addErrorCard(videoResults, file, err.message);
  }

  finishProcessing();
  videoInput.value = '';
}

function addVideoResult(file, result) {
  const card = document.createElement('div');
  card.className = 'result-card';

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
        <span class="stat">🎬 ffmpeg.wasm</span>
      </div>
    </div>
    <button class="download-btn">⬇️ ダウンロード</button>
  `;

  const downloadBtn = card.querySelector('.download-btn');
  const baseName = file.name.replace(/\.[^.]+$/, '');
  downloadBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = `${baseName}_compressed.mp4`;
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

// ===== デバッグパネル =====
const debugToggle = document.getElementById('debugToggle');
const debugPanel = document.getElementById('debugPanel');
const debugCopyBtn = document.getElementById('debugCopyBtn');

debugToggle.addEventListener('click', () => {
  debugPanel.classList.toggle('active');
});

debugCopyBtn.addEventListener('click', async () => {
  const logs = debugPanel.innerText || 'ログなし';
  try {
    await navigator.clipboard.writeText(logs);
    debugCopyBtn.textContent = '✅ コピーしました!';
  } catch (e) {
    // フォールバック: テキストエリアを表示して手動コピー
    const ta = document.createElement('textarea');
    ta.value = logs;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '100%';
    ta.style.height = '300px';
    ta.style.fontSize = '12px';
    ta.style.zIndex = '99999';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    debugCopyBtn.textContent = '✅ コピーしました!';
  }
  setTimeout(() => { debugCopyBtn.textContent = '📋 ログをすべてコピー'; }, 2000);
});

// ブラウザ情報を初期ログに出力
function logBrowserInfo() {
  const lines = [];
  lines.push(`UA: ${navigator.userAgent}`);
  lines.push(`Platform: ${navigator.platform}`);
  lines.push(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined' ? '✅ 利用可能' : '❌ 利用不可'}`);
  lines.push(`crossOriginIsolated: ${self.crossOriginIsolated}`);
  lines.push(`WebAssembly: ${typeof WebAssembly !== 'undefined' ? '✅' : '❌'}`);
  lines.push(`Device Memory: ${navigator.deviceMemory || 'unknown'} GB`);
  lines.push(`Hardware Concurrency: ${navigator.hardwareConcurrency || 'unknown'} cores`);

  const time = new Date().toLocaleTimeString();
  lines.forEach(line => {
    const entry = `[${time}] [INFO] ${line}`;
    console.log(entry);
    const div = document.createElement('div');
    div.className = 'debug-line debug-info';
    div.textContent = entry;
    debugPanel.appendChild(div);
  });
}

logBrowserInfo();
