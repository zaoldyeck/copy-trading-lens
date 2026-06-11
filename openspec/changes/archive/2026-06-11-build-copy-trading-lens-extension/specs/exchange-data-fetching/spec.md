## ADDED Requirements

### Requirement: Fetch Binance lead trader data
The extension SHALL fetch Binance lead trader data from same-origin page APIs for the current portfolio id, including detail, current positions, position history, order history, and transfer history when those endpoints are available.

#### Scenario: Binance APIs return full data
- **WHEN** Binance same-origin API requests succeed
- **THEN** the extension passes detail, current positions, position history, order history, and transfer history to the analysis engine

#### Scenario: Binance API partially fails
- **WHEN** one or more Binance API requests fail or return empty data
- **THEN** the extension still analyzes the available datasets and reports which datasets were unavailable

### Requirement: Fetch OKX lead trader data
The extension SHALL fetch OKX lead trader data from public same-origin APIs for the current uniqueName, including available profile/rank data, position history, and current positions.

#### Scenario: OKX APIs return full data
- **WHEN** OKX public API requests succeed
- **THEN** the extension passes rank/profile data, position history, and current positions to the analysis engine

#### Scenario: OKX profile data cannot be found
- **WHEN** the current OKX trader is not present in the fetched public rank/profile data
- **THEN** the extension analyzes history and live positions if available and marks profile metrics as unavailable

### Requirement: Use visible page data as fallback
The extension SHALL parse visible page text for key metrics only as a fallback or supplement when API fields are missing.

#### Scenario: API missing MDD
- **WHEN** API data lacks a maximum drawdown field but the page text contains maximum drawdown
- **THEN** the extension uses the page text value and marks it as fallback-derived

### Requirement: Protect credentials and user data
The extension MUST NOT store, transmit, log, or expose user cookies, headers, API keys, account ids, or private account data.

#### Scenario: Fetching with active session
- **WHEN** same-origin API requests include the browser's normal session context
- **THEN** the extension uses the response only in memory for local analysis and does not persist credentials or raw private headers
