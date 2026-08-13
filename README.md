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
- 🎬 Canvas + MediaRecorder API（ブラウザネイティブ・ハードウェアエンコード）
- 🎯 10MB以下に自動圧縮
- 📐 自動解像度ダウンスケール
- 🔄 サイズ超過時の自動再圧縮
- ✅ 大容量ファイル対応（ffmpeg.wasm不要・低メモリ）

### 共通
- 🔒 完全ローカル処理（サーバー通信ゼロ）
- 📱 スマホ・PC両対応
- 🔍 デバッグパネル搭載（エラー原因を画面表示・コピペ可能）

## 🚀 使い方

[GitHub Pagesのリンク](https://moruton1119.github.io/discord-image-compressor/) にアクセスするだけ！

## 🛠️ 技術構成

| 機能 | 技術 |
|------|------|
| 画像圧縮 | Rust/WASM（wasm-pack `--target web`）|
| 動画圧縮 | Canvas API + MediaRecorder API |
| フロントエンド | HTML + Vanilla JS（依存ライブラリゼロ）|
| ホスティング | GitHub Pages |

## 📄 開発ドキュメント

開発の経緯・躓いたポイント・解決方法は [DEVLOG.md](./DEVLOG.md) を参照。

## 📄 ライセンス

MIT
