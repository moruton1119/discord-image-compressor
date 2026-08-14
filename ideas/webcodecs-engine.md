# 🚀 WebCodecs動画圧縮エンジン実装プラン

## 概要
Canvas + MediaRecorder（現行）をフォールバックにして、
WebCodecs APIベースの高速動画圧縮エンジンをメインにする。

## アーキテクチャ
```
動画ファイル
  → mp4box.js でデマルチプレクス（映像/音声分離）
  → WebCodecs VideoDecoder でデコード（ハードウェア・爆速）
  → Canvas経由でリサイズ（必要に応じて）
  → WebCodecs VideoEncoder でエンコード（ハードウェア・爆速）
  → mp4-muxer でマルチプレクス（MP4にまとめる）
  → 出力
```

## ライブラリ
- **mp4box.js**: MP4のdemux（映像チャンク抽出）
- **mp4-muxer**: エンコード済みチャンクをMP4にmux
- どちらも軽量・ブラウザネイティブ動作

## フォールバック
```js
if ('VideoEncoder' in window && 'VideoDecoder' in window) {
  // WebCodecs（爆速）
} else {
  // MediaRecorder（フォールバック・現行維持）
}
```

## フェーズ
1. Phase 1: WebCodecsエンジン実装（映像のみ・音声なし）
2. Phase 2: 音声対応
3. Phase 3: サイズ超過時の自動再圧縮ループ
