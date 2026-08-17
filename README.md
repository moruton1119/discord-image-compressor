# 🖼️🎬 Discord 圧縮くん

Discordのプラン別添付ファイル上限（無料 20MB / Nitro Basic 50MB / Nitro 500MB）に合わせた、画像・動画圧縮Webアプリ。
**完全ローカル処理**（サーバー不要・ファイル送信なし）。

## ✨ 機能

### 共通
- 🏷️ **Discordプラン選択**（無料 / Nitro Basic / Nitro）で圧縮目標サイズを切替
  - 無料: 20MB目標・最大1280px / Nitro Basic: 50MB目標・最大1920px / Nitro: 500MB目標・元解像度維持
- ✖️ 圧縮中のキャンセルボタン
- ⚠️ 目標未達時も最終結果を妥協案としてダウンロード可能

### 画像圧縮
- 📎 ドラッグ&ドロップ or タップでアップロード
- 🎯 選択プランの上限以下に自動圧縮（二分探索でギリギリまで画質を保つ）
- 🗑️ EXIF/メタデータ全削除
- 📦 WebP / JPEG 切替可能（PNGは可逆のため制限超過の恐れあり、非対応）
- 🦀 Rust/WASMエンジン搭載

### 動画圧縮
- 🎬 **WebCodecs API**（メインエンジン・ハードウェアエンコード・HEVC/H.265対応）
- 🎥 Canvas + MediaRecorder API（フォールバック・ブラウザネイティブ）
- 🎯 選択プランの上限以下に自動圧縮（実測ビットレート逆算で再圧縮回数を最小化）
- 📐 自動解像度ダウンスケール（プラン別上限）
- ⏭️ 上限以下のファイルは圧縮スキップ（品質保持）
- 📊 処理フェーズ全体のプログレスバー表示

### 実績
- **679MBの4K HEVC動画 → 6.94MB（98.9%圧縮）を75秒で処理**

### その他
- 🔒 完全ローカル処理（サーバー通信ゼロ）
- 📱 スマホ・PC両対応（レスポンシブ）
- 📦 全ライブラリ同梱（CDN依存ゼロ）
- 📜 ページ内に更新履歴表示

## 🚀 使い方

[GitHub Pagesのリンク](https://moruton1119.github.io/discord-image-compressor/) にアクセスするだけ！

## 🛠️ 技術構成

| 機能 | 技術 |
|------|------|
| 画像圧縮 | Rust/WASM（wasm-pack `--target web`）|
| 動画圧縮 | WebCodecs API（mp4box.js + mp4-muxer同梱）|
| 動画フォールバック | Canvas API + MediaRecorder API |
| フロントエンド | HTML + Vanilla JS（依存ライブラリゼロ）|
| ホスティング | GitHub Pages |

## 📄 開発ドキュメント

- [PORTFOLIO.md](./PORTFOLIO.md) — ポートフォリオ（技術アーキテクチャ・実績数字）
- [DEVLOG.md](./DEVLOG.md) — 開発ログ（躓いたポイント・解決方法）

## 📄 ライセンス

MIT
