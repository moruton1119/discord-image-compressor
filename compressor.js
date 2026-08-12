/**
 * Discord 画像圧縮くん - 画像圧縮エンジン
 * 完全ローカル処理（Canvas API ベース）
 * 
 * 圧縮ロジック:
 * 1. EXIF/メタデータ全削除（Canvas再描画で自動削除）
 * 2. フォーマット最適化（WebP/JPEG）
 * 3. 品質を二分探索で目標サイズにギリギリ寄せる
 * 4. それでも無理なら解像度を下げる
 */

const TARGET_SIZE_MB = 10;
const TARGET_SIZE_BYTES = TARGET_SIZE_MB * 1024 * 1024;

// ============ DOM要素 ============
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const results = document.getElementById('results');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const formatSelect = document.getElementById('formatSelect');

// ============ イベントリスナー ============
uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
});

// ============ ファイル処理 ============
async function handleFiles(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    alert('画像ファイルをアップロードしてください');
    return;
  }

  progressBar.classList.add('active');
  const format = formatSelect.value;

  for (let i = 0; i < imageFiles.length; i++) {
    updateProgress((i / imageFiles.length) * 100);
    try {
      const result = await compressImage(imageFiles[i], format);
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
  }, 500);
}

function updateProgress(percent) {
  progressFill.style.width = `${percent}%`;
}

// ============ 画像圧縮メインロジック ============
/**
 * 画像を圧縮して目標サイズ以下にする
 * @param {File} file - 入力画像ファイル
 * @param {string} format - 出力フォーマット (webp/jpeg/png)
 * @returns {Promise<{blob: Blob, width: number, height: number, quality: number, scale: number}>}
 */
async function compressImage(file, format) {
  const bitmap = await loadBitmap(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;

  // PNG以外は圧縮処理へ
  if (format === 'png') {
    const canvas = createCanvas(bitmap, originalWidth, originalHeight);
    const blob = await canvasToBlob(canvas, 'image/png');
    return {
      blob,
      width: originalWidth,
      height: originalHeight,
      quality: 1.0,
      scale: 1.0,
    };
  }

  const mimeType = format === 'webp' ? 'image/webp' : 'image/jpeg';

  // ステップ1: フル解像度で二分探索
  let result = await binarySearchCompression(bitmap, originalWidth, originalHeight, mimeType);

  // ステップ2: 目標サイズに満たない場合、解像度を下げる
  if (result.blob.size > TARGET_SIZE_BYTES) {
    result = await progressiveDownscale(bitmap, originalWidth, originalHeight, mimeType);
  }

  return result;
}

/**
 * ImageBitmapをロード（フォールバック付き）
 */
async function loadBitmap(file) {
  // createImageBitmapが使えるなら使う（高速・EXIF無視）
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      console.warn('createImageBitmap failed, falling back to Image element');
    }
  }

  // フォールバック: Image要素
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像の読み込みに失敗しました'));
    };
    img.src = url;
  });
}

/**
 * Canvas作成（EXIF/メタデータは自動で削除される）
 */
function createCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // JPEGの場合は白背景で塗りつぶし（透明部分の黒化を防ぐ）
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Blob変換ヘルパー
 */
function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas → Blob 変換に失敗'));
      },
      mimeType,
      quality ?? undefined
    );
  });
}

/**
 * 二分探索で品質を調整して目標サイズに寄せる
 * @returns {{blob: Blob, quality: number}}
 */
async function binarySearchCompression(source, width, height, mimeType) {
  let low = 0.01;
  let high = 1.0;
  let bestBlob = null;
  let bestQuality = high;

  const MAX_ITERATIONS = 20;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const mid = (low + high) / 2;
    const canvas = createCanvas(source, width, height);
    const blob = await canvasToBlob(canvas, mimeType, mid);

    if (blob.size <= TARGET_SIZE_BYTES) {
      // 目標以下 → 品質を上げられる
      bestBlob = blob;
      bestQuality = mid;
      low = mid;
    } else {
      // 目標超過 → 品質を下げる
      high = mid;
    }

    // 収束判定（差が1%未満）
    if (high - low < 0.01) break;
  }

  // bestBlobが設定されていない（品質1%でも大きい）場合は最低品質の結果を返す
  if (!bestBlob) {
    const canvas = createCanvas(source, width, height);
    bestBlob = await canvasToBlob(canvas, mimeType, 0.01);
    bestQuality = 0.01;
  }

  return {
    blob: bestBlob,
    width,
    height,
    quality: bestQuality,
    scale: 1.0,
  };
}

/**
 * 解像度を段階的に下げて目標サイズを達成する
 */
async function progressiveDownscale(source, originalWidth, originalHeight, mimeType) {
  let currentWidth = originalWidth;
  let currentHeight = originalHeight;
  let bestResult = null;

  // スケール段階: 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1
  const scales = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];

  for (const scale of scales) {
    currentWidth = Math.round(originalWidth * scale);
    currentHeight = Math.round(originalHeight * scale);

    // 最小サイズ保証
    if (currentWidth < 32 || currentHeight < 32) break;

    const result = await binarySearchCompression(source, currentWidth, currentHeight, mimeType);

    if (result.blob.size <= TARGET_SIZE_BYTES) {
      bestResult = { ...result, scale };
      break;
    }

    // 最後までダメなら最小スケールの結果を保持
    if (!bestResult || result.blob.size < bestResult.blob.size) {
      bestResult = { ...result, scale };
    }
  }

  return bestResult;
}

// ============ 結果表示 ============
function addResultCard(originalFile, result) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const previewUrl = URL.createObjectURL(result.blob);
  const originalSizeKB = (originalFile.size / 1024).toFixed(0);
  const compressedSizeKB = (result.blob.size / 1024).toFixed(0);
  const originalSizeMB = (originalFile.size / (1024 * 1024)).toFixed(2);
  const compressedSizeMB = (result.blob.size / (1024 * 1024)).toFixed(2);
  const ratio = ((1 - result.blob.size / originalFile.size) * 100).toFixed(1);

  const qualityPercent = (result.quality * 100).toFixed(0);
  const scalePercent = (result.scale * 100).toFixed(0);

  const formatName = result.blob.type.split('/')[1].toUpperCase();

  card.innerHTML = `
    <img class="preview" src="${previewUrl}" alt="プレビュー">
    <div class="info">
      <div class="filename">${escapeHtml(originalFile.name)}</div>
      <div class="stats">
        <span class="stat before">📐 ${originalSizeMB} MB</span>
        <span class="stat after">📦 ${compressedSizeMB} MB</span>
        <span class="stat ratio">⚡ ${ratio}% 圧縮</span>
        <span class="stat">🎨 ${qualityPercent}% Q</span>
        <span class="stat">📏 ${scalePercent}% Scale</span>
        <span class="stat">🔖 ${formatName}</span>
      </div>
    </div>
    <button class="download-btn" data-url="${previewUrl}">⬇️ ダウンロード</button>
  `;

  const downloadBtn = card.querySelector('.download-btn');
  const extension = result.blob.type === 'image/webp' ? 'webp' :
                    result.blob.type === 'image/jpeg' ? 'jpg' : 'png';
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
