# 📦 Discord 画像/動画 圧縮くん — 開発ドキュメント

## 概要

Discord無料プランの添付ファイル10MB制限に向けた、画像・動画圧縮Webアプリ。
**完全ローカル処理**（サーバー不要・ファイル送信なし）。

🔗 **公開URL**: https://moruton1119.github.io/discord-image-compressor/
📂 **リポジトリ**: https://github.com/moruton1119/discord-image-compressor

---

## 開発タイムライン

### Phase 1: 画像圧縮（✅ 完成）
| 日付 | コミット | 内容 |
|------|---------|------|
| 2026-08-12 | `39089c1` | 🎉 初回コミット: Canvas APIベースの画像圧縮 |
| 2026-08-12 | `76fbffe` | 🚀 GitHub Pages デプロイ設定 |
| 2026-08-12 | `2e84d9a` | ✨ 処理中表示＆連続ドロップ防止 |
| 2026-08-12 | `1c2a11c` | 🦀 Rust/WASM画像圧縮エンジン統合（image_compressor_bg.wasm） |

### Phase 2: 動画圧縮（✅ 完成）
| 日付 | コミット | 内容 |
|------|---------|------|
| 2026-08-12 | `5812e2c` | 🎬 動画圧縮機能追加（ffmpeg.wasm）+ タブUI |
| 2026-08-12 | `5003113` | 🔍 デバッグパネル追加（スマホでエラー画面表示・コピペ可能） |
| 2026-08-12 | `568f5e1` | 🐛 classWorkerURL追加でffmpeg Worker ロード問題を修正 |
| 2026-08-12 | `45ebb5b` | 🔍 動画タブのイベント発火をトレースするログ追加 |
| 2026-08-12 | `7e88099` | 🐛 ESM→UMD版に切り替え（`Unexpected reserved word`解決） |
| 2026-08-12 | `dc4d59f` | 🐛 toBlobURL/fetchFile を自前実装（UMD版util不具合回避） |
| 2026-08-12 | `ac83497` | 🐛 静的import → 動的import() に変更（真っ白画面防止） |
| 2026-08-12 | `00fd767` | 🐛 WASM init を default export から正しく取得 |
| 2026-08-12 | `435f8e4` | 🔍 ffmpegロードのタイムアウト + ダウンロード進捗ログ追加 |
| 2026-08-12 | `f624ce7` | 🐛 ffmpeg.wasm 0.12 → 0.11 に切り替え（Worker問題） |
| 2026-08-13 | `e77bdc2` | 🐛 `@ffmpeg/core-st`（シングルスレッド版）に切り替え |
| 2026-08-13 | `29f9673` | 🐛 `mainName: 'main'` 追加（core-st互換性） |
| 2026-08-13 | `08c21d6` | 🔍 出力サイズ0バイト問題のデバッグ強化 |
| 2026-08-13 | `adf22c0` | 🚀 **ffmpeg.wasm廃止！Canvas + MediaRecorder に全面移行** |
| 2026-08-13 | `d435493` | 🎨 プログレスバーがスピナーで隠れる問題を修正 |

---

## 躓いたポイントと解決方法（動画圧縮編）

ffmpeg.wasmを使った動画圧縮機能の実装で、**7体のボス**と戦った。

### 🐛 1. `Unexpected reserved word`（ESM import構文エラー）

**原因**: ffmpeg.wasm 0.12のESM版 `import` 文が、Pixel 9（Android Chrome）で構文エラーになる。

**解決**: UMD版（`<script>`タグ読み込み）に切り替え。
```js
// ❌ ESM版（モバイルで失敗）
import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';

// ✅ UMD版（script タグで読み込み）
await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js');
const FFmpeg = window.FFmpegWASM.FFmpeg;
```

---

### 🐛 2. `_toBlobURL is not a function`（UMD版util非互換）

**原因**: `@ffmpeg/util` のUMD版が `require()` を使っており、ブラウザ単体では動かない。

**解決**: `toBlobURL` と `fetchFile` を自前実装。
```js
async function toBlobURL(url, mimeType) {
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}
```

---

### 🐛 3. 画面が真っ白になる（静的importのパースエラー）

**原因**: `app.js` 先頭の `import init, { ImageCompressor } from './image_compressor.js'` がパースエラーを起こすと、HTMLの描画自体が止まる。

**解決**: 静的importを動的 `import()` に変更。
```js
// ❌ 静的import（パース時に失敗すると画面が真っ白）
import init, { ImageCompressor } from './image_compressor.js';

// ✅ 動的import（実行時まで遅延）
const wasmModule = await import('./image_compressor.js');
const init = wasmModule.default;
```

---

### 🐛 4. `wasmModule.init is not a function`（default export問題）

**原因**: wasm-pack `--target web` の場合、`init` 関数は `default` exportとして出力される。`wasmModule.init` では取得できない。

**解決**: `wasmModule.default` から取得。
```js
// ❌ init は名前付きexportだと思ってた
await wasmModule.init('./image_compressor_bg.wasm');

// ✅ default export だった
const init = wasmModule.default;
await init('./image_compressor_bg.wasm');
```
**確認方法**: `grep "export" image_compressor.js` → `export { initSync, __wbg_init as default };`

---

### 🐛 5. ffmpeg 0.12 Worker永遠ロード（ビルドパス問題）

**原因**: ffmpeg.wasm 0.12 のUMD版は、Worker生成コードに**開発者のローカルパス**が埋め込まれている。
```js
// UMD版の内部コード（問題個所）
new Worker(new URL(s, "file:///Users/focus/Projects/ffmpeg.wasm/..."), {type:"module"})
```
Blob URLを渡しても、base URLがローカルパスのためWorkerが永遠に生成されない → タイムアウト。

**解決**: ffmpeg.wasm 0.11（`createFFmpeg` API）に切り替え。
```js
// 0.11は Worker問題なし
const { createFFmpeg } = window.FFmpeg;
const ffmpeg = createFFmpeg({ corePath: '...', log: true });
await ffmpeg.load();
```

---

### 🐛 6. `SharedArrayBuffer is not defined`（GitHub Pages非対応）

**原因**: ffmpeg.wasm 0.11の標準coreもSharedArrayBufferを使用する。GitHub PagesはCOOP/COEPヘッダーが設定不可なため、SABが使えない。

**解決**: `@ffmpeg/core-st`（シングルスレッド版・SAB不要）に切り替え。
```js
createFFmpeg({
  corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
  mainName: 'main',  // ← core-stは proxy_main ではなく _main を使う
});
```
`mainName: 'main'` の指定が必須（`proxy_main` がエクスポートされていないため）。

---

### 🐛 7. 395MB動画で出力0バイト（メモリ不足クラッシュ）

**原因**: ffmpeg.wasmはファイル全体をメモリ（WASM仮想FS）に載せる必要がある。
- 395MBファイル → 約1.6GBのメモリ消費（File + ArrayBuffer + Uint8Array + WASM FS）
- スマホ（8GB RAM）ではOS+ブラウザで4GB使用済み → メモリ不足でffmpegクラッシュ
- 結果: 空のMP4ヘッダー（48バイト）だけ出力される

**解決**: **ffmpeg.wasmを完全に廃止**し、Canvas + MediaRecorder APIに移行。

---

## 🚀 最終解決: ffmpeg.wasm → Canvas + MediaRecorder

ffmpeg.wasmのすべての問題（SAB、Worker、メモリ、速度）を一括解決するため、**ブラウザネイティブAPI**に全面移行した。

### 仕組み

```
動画ファイル
  → <video>要素で再生
  → Canvasに描画（解像度調整可能）
  → MediaRecorderでCanvas + 音声を録画
  → 圧縮完了
```

### 比較

| 項目 | ffmpeg.wasm（旧） | MediaRecorder（新） |
|------|-------------------|---------------------|
| 追加ダウンロード | 30MB（core+wasm） | **ゼロ** |
| メモリ使用量 | ファイルサイズ×3 | **ストリーミング処理** |
| エンコード速度 | ソフトウェア（遅） | **ハードウェア**（爆速） |
| SharedArrayBuffer | 必要（問題あり） | **不要** |
| 大容量ファイル | ❌ クラッシュ | ✅ 動作 |
| GitHub Pages | ❌ 制約多数 | ✅ 完全対応 |

### 圧縮ロジック

1. 動画の長さから目標ビットレートを計算: `bitrate = (10MB × 8) / duration - audioBitrate`
2. 必要に応じて解像度をダウンスケール（最大1280px）
3. Canvas + MediaRecorderで録画
4. ファイルサイズが10MBを超えたら、ビットレートと解像度を下げて再圧縮

---

## 現在の技術構成

### 画像圧縮
- 🦀 **Rust/WASM**（wasm-pack `--target web`）
- Canvas API + Rustによるバイナリサーチ圧縮
- WebP / JPEG / PNG 切替可能
- EXIF/メタデータ全削除

### 動画圧縮
- 🎬 **Canvas + MediaRecorder API**（ブラウザネイティブ）
- ハードウェアエンコード
- 自動ビットレート計算 + 解像度ダウンスケール
- サイズ超過時の自動再圧縮

### インフラ
- 📦 **GitHub Pages**（無料ホスティング）
- 🔄 GitHub Actions で自動デプロイ
- 依存ライブラリゼロ（バニラJS）

---

## 教訓・知見

### ffmpeg.wasmを使うべきでないケース
1. **GitHub Pages等の静的ホスティング** — COOP/COEPヘッダーが設定不可
2. **大容量ファイル（100MB超）** — メモリ不足でクラッシュ
3. **モバイル対応** — 30MBのcoreダウンロードが重い、シングルスレッドで遅い
4. **シンプルな圧縮のみが必要** — MediaRecorder APIで十分な場合が多い

### wasm-pack `--target web` の罠
- `init` 関数は `default` export になる（名前付きexportではない）
- `grep "export" image_compressor.js` で確認が必須

### ESM vs UMD
- ESMの `import` 文は、パース時に失敗すると**画面全体が描画されない**
- モバイル環境ではUMD版（`<script>`タグ）の方が安全
- 動的 `import()` を使えば、パースエラーを防げる

### デバッグパネルの重要性
- スマホ実機でのデバッグはDevToolsが使えない場合が多い
- 画面上にデバッグログを表示 + コピーボタンがあると超便利
- 問題の切り分けが劇的に早くなる

---

## 今後の展望

- [ ] WebCodecs API対応（更なる高速化・エンコード品質向上）
- [ ] WebM → MP4 変換オプション
- [ ] 圧縮プリセット（高速/高品質）
- [ ] PWA対応（オフライン動作）
