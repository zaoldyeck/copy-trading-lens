# exchange-data-fetching Specification

## Purpose
Defines provider behavior for fetching Binance/OKX lead-trader data from current-page same-origin APIs, including partial-failure reporting, retries, and credential/data protection constraints.
## Requirements
### Requirement: Fetch Binance lead trader data
The extension SHALL fetch Binance lead trader data from same-origin page APIs for the current portfolio id, including detail, current positions, position history, order history, transfer history, and standard performance windows when those endpoints are available.

#### Scenario: Binance APIs return full data
- **WHEN** Binance same-origin API requests succeed
- **THEN** the extension passes detail, current positions, position history, order history, transfer history, standard performance windows, and history completeness metadata to the analysis engine

#### Scenario: Binance API partially fails
- **WHEN** one or more Binance API requests fail or return empty data
- **THEN** the extension still analyzes the available datasets and reports which datasets were unavailable

#### Scenario: Binance paged history is temporarily busy
- **WHEN** Binance paged history APIs return transient busy, rate-limit, network, or server errors
- **THEN** the extension retries the failed page with backoff until the page succeeds before continuing analysis

#### Scenario: Standard performance windows are fetched
- **WHEN** Binance detail provides a nickname or the portfolio can be found by bounded list scan
- **THEN** the extension fetches live `7D`, `30D`, `90D`, `180D`, and `365D` ROI/MDD rows for the current portfolio id independent of the page-selected time range

### Requirement: Fetch OKX lead trader data
The extension SHALL fetch OKX lead trader data from public same-origin APIs for the current uniqueName, including available profile/rank data, position history, and current positions.

#### Scenario: OKX APIs return full data
- **WHEN** OKX public API requests succeed
- **THEN** the extension passes rank/profile data, position history, and current positions to the analysis engine

#### Scenario: OKX profile data cannot be found
- **WHEN** the current OKX trader is not present in the fetched public rank/profile data
- **THEN** the extension analyzes history and live positions if available and marks profile metrics as unavailable

### Requirement: Use visible page data as fallback
The extension SHALL parse visible page text for key metrics only as a fallback or supplement when API fields and reconstructed metrics are missing.

#### Scenario: API missing MDD
- **WHEN** API data lacks a maximum drawdown field but the page text contains maximum drawdown
- **THEN** the extension uses the page text value and marks it as fallback-derived

#### Scenario: Fallback data is missing
- **WHEN** neither API nor visible page text provides a metric
- **THEN** the extension keeps the metric unavailable instead of coercing it to zero

### Requirement: Protect credentials and user data
The extension MUST NOT store, transmit, log, or expose user cookies, headers, API keys, account ids, or private account data.

#### Scenario: Fetching with active session
- **WHEN** same-origin API requests include the browser's normal session context
- **THEN** the extension uses the response only in memory for local analysis and does not persist credentials or raw private headers
