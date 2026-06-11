## MODIFIED Requirements

### Requirement: Fetch Binance lead trader data
The extension SHALL fetch Binance lead trader data from same-origin page APIs for the current portfolio id, including detail, current positions, position history, order history, transfer history, and standard performance windows when those endpoints are available.

#### Scenario: Binance APIs return full data
- **WHEN** Binance same-origin API requests succeed
- **THEN** the extension passes detail, current positions, position history, order history, transfer history, standard performance windows, and history completeness metadata to the analysis engine

#### Scenario: Binance API partially fails
- **WHEN** one or more Binance API requests fail or return empty data
- **THEN** the extension still analyzes the available datasets and reports which datasets were unavailable

#### Scenario: Standard performance windows are fetched
- **WHEN** Binance detail provides a nickname or the portfolio can be found by bounded list scan
- **THEN** the extension fetches live `7D`, `30D`, `90D`, `180D`, and `365D` ROI/MDD rows for the current portfolio id independent of the page-selected time range

### Requirement: Use visible page data as fallback
The extension SHALL parse visible page text for key metrics only as a fallback or supplement when API fields and reconstructed metrics are missing.

#### Scenario: API missing MDD
- **WHEN** API data lacks a maximum drawdown field but the page text contains maximum drawdown
- **THEN** the extension uses the page text value and marks it as fallback-derived

#### Scenario: Fallback data is missing
- **WHEN** neither API nor visible page text provides a metric
- **THEN** the extension keeps the metric unavailable instead of coercing it to zero
