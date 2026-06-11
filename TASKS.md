# Tasks

## Public Chrome Extension Release

- [x] Create an independent public extension repository with no private bot-repo files, headers, cookies, or cached exchange data.
- [x] Use Chrome Manifest V3.
- [x] Avoid static lead-trader rankings or packaged historical snapshots; analyze the current lead page live.
- [x] Implement Binance provider for profile, current positions, position history, order history, transfer history, and exchange performance windows.
- [x] Implement OKX provider for available public profile/rank data, position history, and current positions.
- [x] Retry transient Binance history-page failures until the target page succeeds.
- [x] Reconstruct Binance all-period ROI/PnL where transfer and current-equity data are available.
- [x] Add annualized return using XIRR/APY first and CAGR fallback.
- [x] Implement risk analysis for ROI/MDD, payoff ratio, holding time, adverse adds, capital injections, current floating-loss holding, and high-frequency copyability risk.
- [x] Render a collapsible overlay on Binance/OKX lead-trader pages.
- [x] Add popup, generated icons, and release-ready extension package.
- [x] Add Chrome i18n with English default and Taiwan Traditional Chinese support.
- [x] Write English default README and Taiwan Traditional Chinese README.
- [x] Add privacy policy and user-facing installation documentation.
- [x] Add GitHub Actions workflow that builds the extension ZIP and attaches it to tagged GitHub Releases.
- [x] Use `CC-BY-NC-4.0` licensing: attribution required, modification allowed, commercial use prohibited.
- [x] Validate manifest/files/JavaScript syntax/secret patterns and package the extension ZIP.
- [x] Push the independent public GitHub repository.

## Future Ideas

- [ ] User-configurable risk thresholds.
- [ ] Export a single lead-trader analysis JSON from the overlay.
- [ ] Better OKX public data coverage if more stable public endpoints become available.
- [ ] Automated browser smoke test with an unpacked extension fixture page.
