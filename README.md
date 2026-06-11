# Copy Trading Lens

[台灣正體中文 README](README.zh-TW.md)

Copy Trading Lens is a Chrome Extension that analyzes Binance and OKX copy-trading lead-trader pages in real time.

It is not a trading bot, does not place orders, and does not guarantee profit. Its purpose is to make follower-facing risks visible before you copy: martingale-like behavior, adverse averaging, rescue capital injections, held floating losses, high-frequency micro-profit slippage, weak payoff ratio, and divergence between the lead trader and copiers.

## Features

- Supports Binance lead pages: `/copy-trading/lead-details/<portfolioId>`
- Supports OKX lead pages: `/copy-trading/account/<uniqueName>`
- Runs only when you open an individual lead-trader page
- Does not bundle a static recommendation database
- Fetches fresh same-origin page/session-visible data from the current page
- Reconstructs Binance all-period ROI/PnL from historical transfers, current lead capital, and historical records when available
- Shows annualized return: XIRR/APY when cash flows are sufficient, otherwise CAGR estimated from ROI and elapsed days
- Retries transient Binance history-page failures until the page succeeds
- Computes locally in your browser
- No backend service, analytics, remote code, cookie/header/API key storage, or account-data upload
- Provides explainable verdicts instead of a black-box score
- Uses Chrome extension i18n with English as the default locale and Taiwan Traditional Chinese (`zh_TW`) support

## What It Analyzes

Copy Trading Lens checks the data currently available to your browser session:

- All-period ROI, annualized return, all-period PnL, MDD, trading days, copier PnL/AUM
- Binance 7D / 30D / 90D / 180D / 365D exchange-window cross-checks
- Win rate, average win, average loss, payoff ratio, and expectancy
- Winning and losing trade holding time
- Adverse adds, layering, max layers, order-notional pattern, and high-frequency split orders
- Capital inflow during historical losing positions
- Current floating-loss positions and open exposure
- Whether high-frequency micro-profit behavior is likely to be hard to copy after latency, slippage, minimum size, and fees

## Install Before Chrome Web Store Release

Until the extension is available in the Chrome Web Store, install it from GitHub Releases:

1. Open the latest release on GitHub.
2. Download `copy-trading-lens-<version>.zip`.
3. Unzip it to a local folder.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the unzipped folder.
8. Open a Binance or OKX lead-trader detail page.

## Build From Source

```bash
npm run package
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository folder or `dist/copy-trading-lens/`.
5. Open a Binance or OKX lead-trader detail page.

## Permissions

The manifest requests only:

- `https://www.binance.com/*`
- `https://www.okx.com/*`

The extension needs these host permissions to run on Binance/OKX copy-trading pages and call same-origin APIs that the current browser session can already access. It does not transmit the data to any third-party server.

The content script is injected only on supported copy-trading detail routes:

- `https://www.binance.com/*/copy-trading/lead-details/*`
- `https://www.okx.com/*/copy-trading/account/*`

## Privacy

See [PRIVACY.md](PRIVACY.md).

Summary:

- No backend
- No analytics
- No remote code
- No data upload
- No credential storage
- Same-origin requests may use the browser's normal session context and exchange-required CSRF header, but these values are not stored or sent to third parties
- No static lead-trader database

## Source Validation

```bash
npm run icons
npm run validate
npm run package
```

## Limitations

- Exchange APIs and page structures can change.
- Binance all-period ROI is reconstructed as current lead equity plus withdrawals minus deposits. If Binance does not expose complete transfer or position history, the panel marks the data as incomplete or `N/A`.
- Annualized return uses XIRR/APY when cash flows are available; otherwise it uses CAGR estimated from ROI and elapsed days. Short samples can produce extreme annualized values and must be read with MDD and trade behavior.
- Binance standard-window ROI/MDD comes from live `query-list` data and is only a cross-check, not a static database.
- Some Binance data may be unavailable when the user is not logged in.
- OKX public data is less complete than Binance order/transfer data, so some OKX conclusions are intentionally conservative.
- Hidden positions are not treated as a negative signal by themselves.
- The analysis is a risk aid, not investment advice.

## License

Creative Commons Attribution-NonCommercial 4.0 International (`CC-BY-NC-4.0`).

You may share and modify the project with attribution, but commercial use is not allowed without separate written permission.
