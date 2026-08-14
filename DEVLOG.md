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

## Phase 3: WebCodecs エンジン（✅ 完成・2026-08-14）

ffmpeg.wasm → MediaRecorder → **WebCodecs**への進化。ブラウザのハードウェアコーデックを直接制御する最終形態。

| 日付 | コミット | 内容 |
|------|---------|------|
| 2026-08-13 | `66b5aba` | 🚀 WebCodecs エンジン実装（mp4box.js + mp4-muxer） |
| 2026-08-13 | `f5b8237` | 📦 同梱化完了！CDN依存を完全排除 |
| 2026-08-14 | `fc0f782` | 🎯 10MB以下は圧縮スキップ・目標9MB |
| 2026-08-14 | `5e545d3` | 🔇 MediaRecorder: 無音+最大4倍速 |
| 2026-08-14 | `2d24301` | 🐛 HEVC(H.265)のWebCodecsデコード対応 |
| 2026-08-14 | `8361390` | 🔇 処理中ログを最小化 |
| 2026-08-14 | `5e9674c` | 🐛 onSamplesからHEVC description取得 |
| 2026-08-14 | `5a66e07` | 🐛 **W3C公式方法でdescription取得 — HEVC完全対応** |
| 2026-08-14 | `2e9d712` | ⚡ 2回圧縮防止（8MB目標に変更） |
| 2026-08-14 | `b4f2f53` | 🎨 プログレスバーを全フェーズにマッピング |
| 2026-08-14 | `faa829f` | 🐛 VBR→CBR（サイズ超過の根本解決） |
| 2026-08-14 | `6df1bfa` | ✨ パーセンテージ表示追加 |

### 🐛 8. HEVC description取得エラー（最大の難所）

**エラー:** `A key frame is required after configure() or flush(). If you're using HEVC formatted H.265 you must fill out the description field in the VideoDecoderConfig.`

**試行錯誤:**
1. `onReady` のtrack infoから `track.mdia.minf.stbl.stsd` で取得 → **mdiaが存在しない**
2. `onSamples` の `sample.description` から取得 → descriptionは取れるがデコード失敗
3. **W3C公式サンプルを発見** → 正解は3点セット

**正解（W3C公式 samples/video-decode-display/demuxer_mp4.js）:**
```js
// ① file.getTrackById() で内部trackを取得（onReadyのinfoではない！）
const trak = file.getTrackById(track.id);
// ② box.write() でシリアライズ（box.dataをそのまま使わない！）
for (const entry of trak.mdia.minf.stbl.stsd.entries) {
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (box) {
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    // ③ 先頭8バイト（ボックスヘッダー）を削除
    return new Uint8Array(stream.buffer, 8);
  }
}
```

### 🐛 9. VBRでサイズ超過（2回圧縮発生）

**現象:** 834kbps指定なのに17.41MB出力（目標10MB）→ 再圧縮で時間2倍

**原因:** `bitrateMode: 'variable'` はビットレートを目安として扱い、複雑なシーンで大幅超過

**解決:** `bitrateMode: 'constant'`（CBR）に戻す + 目標を8MBに。1回のエンコードで確実に制限内。

---

## 🏆 最終成果（実測値）

| テスト動画 | 元サイズ | 結果 | 処理時間 | デバイス |
|-----------|---------|------|---------|----------|
| 1362.mp4 (4K HEVC, 132秒) | **679.77MB** | **6.94MB** | 75秒 | Android スマホ |
| 忍者ギミックPV0814.mp4 (1080p, 84秒) | 393.12MB | 9.61MB | 40秒 | Windows PC |
| 1435.mp4 (4K HEVC, 76秒) | 395.05MB | 6.94MB | 75秒 | Android スマホ |

---

## 現在の技術構成

### 画像圧縮
- 🦀 **Rust/WASM**（wasm-pack `--target web`）
- Canvas API + Rustによるバイナリサーチ圧縮
- WebP / JPEG / PNG 切替可能
- EXIF/メタデータ全削除

### 動画圧縮
- 🎬 **WebCodecs API**（メインエンジン）
  - mp4box.jsでMP4デマックス（同梱）
  - VideoDecoderでハードウェアデコード（HEVC/H.264対応）
  - Canvas経由でリサイズ
  - VideoEncoderでハードウェアH.264エンコード（CBR）
  - mp4-muxerでMP4格納（同梱）
- 🎥 **Canvas + MediaRecorder**（フォールバック）
  - WebCodecs非対応環境向け自動切替
  - 2〜4倍速再生で処理短縮
- 自動ビットレート計算（目標8MB・安全マージン）
- 10MB以下のファイルは圧縮スキップ（品質保持）

### インフラ
- 📦 **GitHub Pages**（無料ホスティング）
- 🔄 GitHub Actions で自動デプロイ（約20秒）
- 依存ライブラリゼロ（CDN不使用・全て同梱）

---

## 教訓・知見

### 動画圧縮エンジンの選択基準（3世代の結論）

| エンジン | 追加DL | 速度 | メモリ | SAB要否 | 結論 |
|---------|--------|------|--------|---------|------|
| ffmpeg.wasm | 約30MB | 遅い（SW） | ×3倍（危険） | 必要 | ❌ 廃止 |
| MediaRecorder | 0 | 実時間の1/2〜1/4 | 安全 | 不要 | ⭕ フォールバック |
| **WebCodecs** | **0** | **爆速（HW）** | **安全** | **不要** | ✅ **最適解** |

### ffmpeg.wasmを使うべきでないケース
1. **GitHub Pages等の静的ホスティング** — COOP/COEPヘッダーが設定不可
2. **大容量ファイル（100MB超）** — メモリ不足でクラッシュ
3. **モバイル対応** — 30MBのcoreダウンロードが重い、シングルスレッドで遅い
4. **シンプルな圧縮のみが必要** — WebCodecs/MediaRecorder APIで十分な場合が多い

### WebCodecs実装のバイブル
- **W3C公式サンプル**（samples/video-decode-display/demuxer_mp4.js）が事実上唯一の信頼できる参考資料
- HEVCのdescription取得は「getTrackById → box.write → 8バイト削除」の3点セット
- `VideoDecoder.isConfigSupported()` で事前チェックすればフォールバック制御が可能

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

- [ ] 音声トラック処理の本格対応（現在は映像のみ）
- [ ] WebM → MP4 変換オプション
- [ ] 圧縮プリセット（高速/高品質）
- [ ] PWA対応（オフライン動作）
