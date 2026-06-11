# binance-reconstructed-performance Specification

## Purpose
Defines Binance all-period performance reconstruction and annualized-return handling from same-origin live data for the current lead portfolio.
## Requirements
### Requirement: Reconstruct Binance all-period performance
The extension SHALL reconstruct Binance lead trader all-period performance from live same-origin API data for the current portfolio id when transfer history, current margin balance, and historical position data are available, including all-period ROI, net profit, and annualized return.

#### Scenario: Complete cash-flow data is available
- **WHEN** Binance transfer history contains deposits/withdrawals and detail contains current margin balance
- **THEN** the analysis reports all-period net profit, ROI calculated from current margin balance plus withdrawals minus deposits, and an XIRR/APY-style annualized return

#### Scenario: Cash-flow annualization is unavailable
- **WHEN** transfer history supports ROI reconstruction but does not support a valid XIRR solve
- **THEN** the analysis reports CAGR estimated from all-period ROI and elapsed days when possible

#### Scenario: Cash-flow data is unavailable
- **WHEN** transfer history or margin balance is unavailable
- **THEN** the analysis marks all-period ROI and annualized return as unavailable instead of displaying zero

### Requirement: Use historical trading records for strategy analysis
The extension SHALL use Binance position history and order history to analyze strategy behavior, including win/loss profile, payoff ratio, holding time, adverse adding, high-frequency behavior, and current floating-loss risk.

#### Scenario: Historical trades are available
- **WHEN** Binance position and order history are fetched
- **THEN** the strategy verdict uses those historical records rather than static data or old reports

### Requirement: Track historical data completeness
The extension SHALL track how many historical records were fetched compared with the exchange-reported total where available.

#### Scenario: History fetch reaches exchange total
- **WHEN** fetched rows are at least the exchange-reported total
- **THEN** the UI reports the dataset as complete for the fetched endpoint

#### Scenario: History fetch waits for transient failures
- **WHEN** a historical page temporarily fails before the exchange-reported total is reached
- **THEN** the extension waits and retries instead of analyzing a partial historical dataset
