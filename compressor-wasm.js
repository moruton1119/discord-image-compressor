/**
 * Discord 画像圧縮くん - WASM版 compressor
 * Rust + WebAssembly でネイティブ速度の画像圧縮！🔥
 * 
 * 圧縮ロジック:
 * 1. Rust(image crate)でデコード → EXIF/メタデータ自動削除
 * 2. JPEG品質を二分探索で目標サイズにギリギリ寄せる
 * 3. それでも無理ならLanczos3で高品質リサイズ
 * 4. WebP losslessモードも選択可能
 */

import init, { ImageCompressor } from './image_compressor.js';

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

// ============ WASM初期化 ============
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

// ============ DOM要素 ============
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const results = document.getElementById('results');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const formatSelect = document.getElementById('formatSelect');
const processingOverlay = document.getElementById('processingOverlay');
const processingText = document.getElementById('processingText');
const processingSubtext = document.getElementById('processingSubtext');
const fileCounter = document.getElementById('fileCounter');

// ============ 処理中フラグ ============
let isProcessing = false;

// ============ イベントリスナー ============
uploadArea.addEventListener('click', () => {
  if (isProcessing) return;
  fileInput.click();
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (isProcessing) return;
  uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  if (isProcessing) return;
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
  if (isProcessing) {
    e.target.value = '';
    return;
  }
  handleFiles(e.target.files);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ページ読み込み時にWASMを事前初期化
ensureWasm().catch(err => console.error('WASM初期化エラー:', err));

// ============ ファイル処理 ============
async function handleFiles(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    alert('画像ファイルをアップロードしてください');
    return;
  }

  // WASM初期化確認
  await ensureWasm();

  isProcessing = true;
  uploadArea.classList.add('processing');
  processingOverlay.classList.add('active');
  progressBar.classList.add('active');

  for (let i = 0; i < imageFiles.length; i++) {
    updateProgress((i / imageFiles.length) * 100);
    updateProcessingUI(i + 1, imageFiles.length, imageFiles[i].name);
    try {
      const result = await compressImageWasm(imageFiles[i]);
      addResultCard(imageFiles[i], result);
    } catch (err) {
      console.error('圧縮エラー:', err);
      addErrorCard(imageFiles[i], err.message);
    }
  }

  updateProgress(100);
  setTimeout(() => {
    progressBar.classList.remove('active');
    progressFill.style.width = '0%';
    uploadArea.classList.remove('processing');
    processingOverlay.classList.remove('active');
    isProcessing = false;
    fileInput.value = '';
  }, 500);
}

function updateProgress(percent) {
  progressFill.style.width = `${percent}%`;
}

function updateProcessingUI(current, total, filename) {
  processingText.textContent = '🦀 Rust/WASM で圧縮処理中...';
  processingSubtext.textContent = truncate(filename, 50);
  fileCounter.textContent = `${current} / ${total} 枚目`;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ============ WASM画像圧縮 ============
async function compressImageWasm(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const format = formatSelect.value;

  // 画像情報取得
  const info = compressor.get_image_info(data);
  console.log(`📷 ${file.name}: ${info.width}x${info.height}, ${info.format}, ${(data.length / 1024 / 1024).toFixed(2)}MB`);

  let blob;

  if (format === 'png') {
    // WebP losslessモード（PNG代替）
    const compressed = compressor.compress_webp_lossless(data);
    blob = new Blob([compressed], { type: 'image/webp' });
    return {
      blob,
      width: info.width,
      height: info.height,
      quality: 100,
      scale: 1.0,
      isLossless: true,
    };
  }

  // JPEG二分探索圧縮（目標サイズに自動調整）
  const compressed = compressor.compress_to_target_size(data, TARGET_SIZE_BYTES);

  if (compressed.length === 0) {
    throw new Error('圧縮に失敗しました');
  }

  const outputFormat = format === 'webp' ? 'image/jpeg' : 'image/jpeg';
  blob = new Blob([compressed], { type: outputFormat });

  // スケール計算（圧縮後サイズから推定）
  const scale = compressed.length <= TARGET_SIZE_BYTES ? 1.0 : 0.5;

  return {
    blob,
    width: info.width,
    height: info.height,
    quality: 0, // WASM側で自動調整
    scale,
    isLossless: false,
  };
}

// ============ 結果表示 ============
function addResultCard(originalFile, result) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const previewUrl = URL.createObjectURL(result.blob);
  const originalSizeMB = (originalFile.size / (1024 * 1024)).toFixed(2);
  const compressedSizeMB = (result.blob.size / (1024 * 1024)).toFixed(2);
  const ratio = ((1 - result.blob.size / originalFile.size) * 100).toFixed(1);

  const engineLabel = result.isLossless ? 'WebP Lossless' : 'JPEG (Rust/WASM)';
  const qualityLabel = result.isLossless ? '100%' : 'Auto';

  card.innerHTML = `
    <img class="preview" src="${previewUrl}" alt="プレビュー">
    <div class="info">
      <div class="filename">${escapeHtml(originalFile.name)}</div>
      <div class="stats">
        <span class="stat before">📐 ${originalSizeMB} MB</span>
        <span class="stat after">📦 ${compressedSizeMB} MB</span>
        <span class="stat ratio">⚡ ${ratio}% 圧縮</span>
        <span class="stat">🦀 ${engineLabel}</span>
        <span class="stat">🎨 Q${qualityLabel}</span>
      </div>
    </div>
    <button class="download-btn">⬇️ ダウンロード</button>
  `;

  const downloadBtn = card.querySelector('.download-btn');
  const extension = result.blob.type === 'image/webp' ? 'webp' : 'jpg';
  const baseName = originalFile.name.replace(/\.[^.]+$/, '');
  const downloadName = `${baseName}_compressed.${extension}`;

  downloadBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  results.prepend(card);
}

function addErrorCard(file, errorMessage) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.style.borderColor = '#f04747';
  card.innerHTML = `
    <div class="preview" style="display:flex;align-items:center;justify-content:center;font-size:2rem;">❌</div>
    <div class="info">
      <div class="filename">${escapeHtml(file.name)}</div>
      <div class="stats">
        <span class="stat" style="color:#f04747;">エラー: ${escapeHtml(errorMessage)}</span>
      </div>
    </div>
  `;
  results.prepend(card);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
