## 1. Project And OpenSpec Setup

- [x] 1.1 Initialize the independent Chrome Extension project with Manifest V3 metadata and no private trading-bot repository files.
- [x] 1.2 Add OpenSpec proposal, design, capability specs, and implementation task ledger for the extension.
- [x] 1.3 Add repository hygiene files so local artifacts, logs, caches, secrets, and build outputs are not tracked.

## 2. Page Detection And Providers

- [x] 2.1 Implement Binance/OKX lead-page detection and SPA navigation refresh.
- [x] 2.2 Implement Binance provider for detail, current positions, position history, order history, transfer history, and visible-page fallback data.
- [x] 2.3 Implement OKX provider for public profile/rank data, position history, current positions, and visible-page fallback data.
- [x] 2.4 Surface partial-fetch failures and dataset coverage without treating missing private data as safety.

## 3. Local Risk Analysis

- [x] 3.1 Implement normalized metric helpers for ROI/MDD, PnL, holding time, payoff ratio, expectancy, and current exposure.
- [x] 3.2 Implement Binance order-history reconstruction for adverse adds, layer count, order notional, grid/add spacing, dominant symbols, and leverage fingerprints.
- [x] 3.3 Implement transfer-history checks for loss-period deposits and capital inflow relative to lead margin.
- [x] 3.4 Implement risk verdict rules for martingale-like behavior, dead-loss holding, high-frequency micro-profit copyability, current floating-loss risk, copier-PnL divergence, MDD, and historical closures.
- [x] 3.5 Ensure the analysis output is explainable with verdict, positives, cautions, evidence, metrics, and data coverage.

## 4. Extension UI

- [x] 4.1 Implement non-invasive overlay UI with loading, success, partial-data, failure, retry, and collapse states.
- [x] 4.2 Show strategy family, verdict, key metrics, risk evidence, positive evidence, data coverage, and practical follower settings.
- [x] 4.3 Implement popup page explaining current-page usage, no-data-collection behavior, and manual refresh guidance.
- [x] 4.4 Add extension styles and generated icons suitable for Chrome Web Store upload.

## 5. Store-Ready Documentation And Packaging

- [x] 5.1 Write README with install, local testing, packaging, permissions, privacy, and publishing steps.
- [x] 5.2 Write privacy policy stating no collection, no remote service, no credential storage, and local-only analysis.
- [x] 5.3 Write Chrome Web Store description and permissions justification text.
- [x] 5.4 Add validation and packaging scripts that verify manifest, files, JavaScript syntax, icon presence, and zip structure.

## 6. Verification, GitHub, And Handoff

- [x] 6.1 Run extension validation, JavaScript syntax checks, and package generation.
- [ ] 6.2 Initialize git, commit the public extension project, and verify tracked files contain no private header/cookie/cache data.
- [ ] 6.3 Create or update the public GitHub repository and push the current branch.
- [ ] 6.4 Report the GitHub URL, Chrome Web Store zip path, validation commands, and any remaining limitations.
