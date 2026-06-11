# Copy Trading Lens

[English](README.md) | [台灣正體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | 日本語

Copy Trading Lens は、Binance / OKX の個別コピートレードリーダーページをリアルタイムに分析する Chrome Extension です。

これは取引ボットではなく、注文を出すことも利益を保証することもありません。目的は、コピー前に見落としやすいリスクを見えるようにすることです。たとえば、マーチンゲール的なサイズ調整、グリッド/レンジ取引、逆行ナンピン、救済的な資金追加、含み損の長期保有、高頻度小幅利益のスリッページ、損益比の弱さ、リーダーとコピー側の成績乖離を確認します。

## Features

- Binance リーダーページに対応：`/copy-trading/lead-details/<portfolioId>`
- OKX リーダーページに対応：`/copy-trading/account/<uniqueName>`
- 個別リーダーページを開いたときだけ実行
- 静的な推薦データベースは同梱しない
- 現在のページから、同一オリジンかつ現在のセッションで見える最新データを取得
- Binance では、取得できる履歴振替、現在のリーダー資金、履歴レコードから全期間 ROI/PnL を再構築
- 年率リターンを表示。十分なキャッシュフローがある場合は XIRR/APY、そうでない場合は ROI と経過日数から CAGR を推定
- Binance の履歴ページが一時的に失敗した場合、対象ページが成功するまで再試行
- すべてブラウザー内でローカル計算
- バックエンド、analytics、remote code、cookie/header/API key 保存、口座データのアップロードなし
- ブラックボックススコアではなく、説明可能な根拠を表示
- Chrome extension locale：英語、台湾繁体字中国語、簡体字中国語、日本語に対応

## What It Analyzes

Copy Trading Lens は、現在のブラウザーセッションで取得できるデータを確認します。

- 全期間 ROI、年率リターン、全期間 PnL、MDD、取引日数、コピー PnL/AUM
- Binance 7D / 30D / 90D / 180D / 365D の取引所標準期間チェック
- 勝率、平均利益、平均損失、損益比、期待値
- 利益取引と損失取引の保有時間
- 履歴注文における逆行追加、分割、最大レイヤー、注文名目金額パターン、高頻度分割注文
- 過去の損失ポジション中の資金流入
- 現在の含み損ポジションとオープンエクスポージャー
- 高頻度小幅利益戦略が、コピー遅延、スリッページ、最小注文サイズ、手数料で再現しにくいかどうか

## Strategy Labels

パネルは、コピー側が判断しやすいように一般的な取引スタイルのラベルを使います。

- **Martingale**：損失時にサイズを増やし、連続逆行でドローダウンが急拡大しやすい。
- **Grid / range trading**：分割注文でレンジを取るが、一方向相場では含み損が積み上がりやすい。
- **DCA / left-side trading**：逆行中に平均化するため、早すぎるコピーはドローダウンを引き継ぎやすい。
- **Right-side / trend following**：方向確認後に入るため、通常は明確な損切りが重要。
- **Scalping**：短時間の小幅利益が中心で、コピー遅延、最小注文サイズ、手数料、スリッページが重要。
- **Market-making tendency**：短期取引が多く、コピー側の執行品質で優位性が消える可能性がある。
- **Swing trading**：保有時間が長めで、コピー側が既存ポジションの変動を引き継ぐ可能性がある。

## Install Before Chrome Web Store Release

Chrome Web Store に公開されるまでは、GitHub Releases からインストールしてください。

1. GitHub の最新 release を開く。
2. `copy-trading-lens-<version>.zip` をダウンロードする。
3. ローカルフォルダーに展開する。
4. `chrome://extensions` を開く。
5. **Developer mode** を有効にする。
6. **Load unpacked** をクリックする。
7. 展開したフォルダーを選択する。
8. Binance または OKX の個別リーダーページを開く。

## Build From Source

```bash
npm run package
```

Chrome での読み込み手順：

1. `chrome://extensions` を開く。
2. **Developer mode** を有効にする。
3. **Load unpacked** をクリックする。
4. この repository フォルダー、または `dist/copy-trading-lens/` を選択する。
5. Binance または OKX の個別リーダーページを開く。

## Repository Layout

```text
.
├── _locales/        Chrome i18n message files
├── assets/icons/    Extension icons
├── openspec/        Public product and packaging specifications
├── scripts/         Validation, icon generation, and packaging scripts
├── src/             Provider adapters, analysis engine, content UI, and popup code
├── manifest.json    Chrome Manifest V3 definition
├── popup.html       Extension action popup
├── PRIVACY.md       Privacy policy
└── README*.md       User and developer documentation
```

## Permissions

manifest は次の host permissions だけを要求します。

- `https://www.binance.com/*`
- `https://www.okx.com/*`

これらの権限は、Binance / OKX のコピートレードページ上で動作し、現在のブラウザーセッションがすでにアクセスできる同一オリジン API を呼び出すために必要です。データを第三者サーバーへ送信することはありません。

Content script は次の対応ページにのみ注入されます。

- `https://www.binance.com/*/copy-trading/lead-details/*`
- `https://www.okx.com/*/copy-trading/account/*`

## Privacy

See [PRIVACY.md](PRIVACY.md).

Summary:

- バックエンドなし
- analytics なし
- remote code なし
- データアップロードなし
- credential 保存なし
- 同一オリジンリクエストでは、ブラウザーの通常セッション情報や取引所が要求する CSRF header を使う場合がありますが、これらを保存したり第三者へ送信したりしません
- 静的なリーダーデータベースなし

## Validation

```bash
npm run icons
npm run validate
npm run package
```

`npm run validate` は、必須ファイル、Manifest V3 制約、host permissions、JavaScript syntax、secret らしい文字列、locale message key の一致を確認します。

## Limitations

- 取引所 API やページ構造は変更される可能性があります。
- Binance の全期間 ROI は「現在のリーダー資金 + 出金 - 入金」で再構築します。Binance が完全な振替履歴やポジション履歴を提供しない場合、パネルはデータ不完全または `N/A` と表示します。
- 年率リターンは、キャッシュフローがある場合は XIRR/APY、そうでない場合は ROI と取引日数から CAGR を推定します。短期間サンプルの年率値は極端になりやすいため、MDD と取引行動と一緒に読む必要があります。
- Binance の標準期間 ROI/MDD は live `query-list` API から取得するクロスチェックであり、静的データベースではありません。
- ログインしていない場合、一部の Binance データは取得できないことがあります。
- OKX の公開データは Binance の注文/振替データほど完全ではないため、一部の判断は保守的です。
- Hidden positions はそれだけでマイナス評価しません。取得できないデータとして表示します。
- この分析はリスク補助であり、投資助言ではありません。

## Support / Donate

Copy Trading Lens が悪いコピー判断を避ける助けになった場合、寄付で開発を支援できます。Extension には支払い機能はなく、Binance や OKX ページ上で送金を求めることもありません。公式 repository owner または Chrome Web Store listing で公開された donation link / address だけを使用してください。

## License

Creative Commons Attribution-NonCommercial 4.0 International (`CC-BY-NC-4.0`).

Attribution を付けて共有・改変できますが、別途書面許可がない限り商用利用はできません。
