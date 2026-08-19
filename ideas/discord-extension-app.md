# 🔌 Discord拡張アプリ（CDPパイプ連携）構想

## 概要
NudeNyang-Discord-Translator方式を参考に、**Discordデスクトップアプリの外脳**
となるWindowsサポートアプリ（exe）を作る。
第一機能は「ファイルドロップ時にプラン上限を超えていたら圧縮して送るか聞く」
だが、最終的には**Discord拡張プラットフォーム**として育てる。

## 参考実装の調査結果（2026-08-19時点）
- リポジトリ: https://github.com/NudeNyang/NudeNyang-Discord-Translator
- 公式サイト: https://nudenyang.github.io/NudeNyang-Discord-Translator/
- 技術スタック: **Tauri 2 + Rust**（WebViewは設定画面のみ、本体はRustコア）
- ライセンス: **GPL-3.0-only**（⚠️ コードをコピーすると伝播する。**方式のみ参考にスクラッチ開発**）

## 核心技術: CDPプライベートパイプ
```
自アプリがDiscordを子プロセスとして起動
  → --remote-debugging-pipe フラグ付き
  → 継承された匿名パイプハンドルでCDP接続
     （TCPポートを開かない = セキュリティ的にクリーン）
  → レンダラーのDOMを読み書き
```
- ユーザートークン不要・self-bot不使用・Discordファイル無改造
- 実行パス検証・PIDハンドオフ・`https://discord.com`ターゲット検証でなりすまし防止

## 機能ロードマップ

### Phase 1: ドロップ圧縮サポート（本体）
```
ファイルをDiscordにドロップ
  → 注入スクリプトがドロップイベント検知
  → サイズ > プラン上限（free 10MB / basic 50MB / nitro 500MB）？
  → ネイティブポップアップ「圧縮して送る？」
  → Yes → Rustコアで圧縮（ffmpeg同梱）
  → 圧縮済みFileをDataTransferで再注入 → 送信
```
検知方式2案:
| 方式 | 内容 | 強み/弱み |
|------|------|----------|
| A: イベント横取り | captureフェーズでdropを先取り | DOM構造非依存 / リスナー順序がシビア |
| B: モーダル監視 | MutationObserverで添付プレビュー検知→差し替え | 安定 / セレクタが更新で壊れる |

→ **まずBで検証、安定したらAへ**

圧縮ロジックは discord-image-compressor（Web版）の資産を流用可能。

### Phase 2: Discord情報の読み取り
CDPでDOMレベルの読み取り:
- 未読バッジ（赤い数字）
- VC参加状況（誰がいるか・ミュート/デフ状態）
- 通知トースト出現検知
- メッセージ・チャンネル名（NudeNyangと同じ）

⚠️ Discord内部ストア（Flux）直叩きはminify名が変わるのでメンテ地獇=やらない
⚠️ トークン取得は絶対NG（BANリスク）

### Phase 3: VRC OSC双方向連携
```
Discord ←(CDP)→ Rustコア ←(OSC UDP 127.0.0.1:9000)→ VRChat
```
**Discord → VRC（簡単・推奨）:**
- 通知/メンション着信 → ChatBox「💬 Discord: ○○からメンション」or アバター通知ランプ
- VC参加/退出 → ChatBox通知 or ジェスチャー
- リアクション → 表情パラメータ発火
- ※OSC送信のみで完結するため安全・安定

**VRC → Discord（工夫が必要）:**
- ワールド移動 → カスタムステータス自動更新（CDPでUI操作）
- ※Discordへの書き込みはDOM操作になるためフォーカス依存・ポリシーグレー

## リスク・注意点
1. **Discordポリシーリスク**: 非公式拡張。NudeNyangも公式サイトで
   「ポリシー解釈により制限される可能性」を明記。トークン不使用・
   ファイル無改造設計で低リスク化
2. **Discord更新で壊れる**: 公式拡張方式ではないため。方式A（イベント横取り）
   はDOM非依存なので耐性高め
3. **GPL-3.0伝播注意**: NudeNyangコードをコピペしない。方式の参考のみ

## 工数感
- CDPパイプ接続のRust実装（起動〜バインディング）: 最大の山場
- 圧縮: ffmpeg同梱で一撃、Web版資産流用可
- プラン判定: 設定UI（Web版と同じ思想）
- 初見で2〜3週間程度

## 関連
- `ideas/discord-image-compressor.md`（Web版・実装済み）
- Discord 圧縮くん: https://moruton1119.github.io/discord-image-compressor/
