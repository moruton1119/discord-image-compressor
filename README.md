# 🖼️🎬 Discord 圧縮くん

Discord無料プランの添付ファイル10MB制限に向けた、画像・動画圧縮Webアプリ。
**完全ローカル処理**（サーバー不要・ファイル送信なし）。

## ✨ 機能

### 画像圧縮
- 📎 ドラッグ&ドロップ or タップでアップロード
- 🎯 10MB以下に自動圧縮（二分探索でギリギリまで画質を保つ）
- 🗑️ EXIF/メタデータ全削除
- 📦 WebP / JPEG / PNG 切替可能
- 🦀 Rust/WASMエンジン搭載

### 動画圧縮
- 🎬 **WebCodecs API**（メインエンジン・ハードウェアエンコード・HEVC/H.265対応）
- 🎥 Canvas + MediaRecorder API（フォールバック・ブラウザネイティブ）
- 🎯 10MB以下に自動圧縮（ビットレート逆算・1回で確実に収める）
- 📐 自動解像度ダウンスケール（最大1280px）
- ⏭️ 10MB以下のファイルは圧縮スキップ（品質保持）
- 📊 処理フェーズ全体のプログレスバー表示

### 実績
- **679MBの4K HEVC動画 → 6.94MB（98.9%圧縮）を75秒で処理**

### 共通
- 🔒 完全ローカル処理（サーバー通信ゼロ）
- 📱 スマホ・PC両対応
- 📦 全ライブラリ同梱（CDN依存ゼロ）
- 🔍 デバッグパネル搭載（エラー原因を画面表示・コピペ可能）

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
