# local-risk-analysis Specification

## Purpose
Defines the local follower-oriented risk analysis engine, including trade-quality metrics, martingale-like behavior detection, capital-injection risk, current floating-loss risk, and explainable verdict output.
## Requirements
### Requirement: Compute core performance and trade quality metrics
The extension SHALL compute follower-oriented metrics from available data, including ROI, MDD, win rate, payoff ratio, expected PnL per closed trade, win/loss holding time, max loss holding time, current unrealized loss, and copier PnL/AUM when available.

#### Scenario: Position history available
- **WHEN** historical closed positions are available
- **THEN** the extension computes win rate, average win, average loss, payoff ratio, expectancy, and win/loss holding time

#### Scenario: Current positions available
- **WHEN** current positions are available
- **THEN** the extension computes open position count, unrealized loss, unrealized loss to margin, notional exposure, and dominant open symbols

### Requirement: Detect non-copyable or high-risk behavior
The extension SHALL flag behavior that can make lead trader results hard or dangerous to copy, including loss-period capital inflow, adverse averaging, long loss holds, high-frequency tiny wins, extreme MDD, current floating-loss hold, and major copier-PnL divergence.

#### Scenario: Loss-period deposit detected
- **WHEN** a transfer deposit occurs during a historical losing position interval
- **THEN** the extension flags loss-period capital inflow as a major risk

#### Scenario: Adverse add with long loss holds detected
- **WHEN** order history shows adverse same-direction adds and losing positions are held materially longer than winning positions
- **THEN** the extension flags martingale-like or grid-like risk

#### Scenario: High-frequency micro-profit strategy detected
- **WHEN** order history is high frequency and average winning PnL is tiny
- **THEN** the extension warns that latency, slippage, minimum order size, and fees can make copier results worse than lead results

### Requirement: Produce explainable verdicts
The extension SHALL output a verdict level, a short title, positive evidence, caution evidence, and data coverage counts instead of only an opaque score.

#### Scenario: Analysis has multiple risks
- **WHEN** multiple major caution rules trigger
- **THEN** the extension returns a high-risk or avoid verdict with concrete evidence strings

#### Scenario: Analysis has insufficient data
- **WHEN** data samples are too small or important datasets are unavailable
- **THEN** the extension returns an observation verdict and explicitly states the data limitation

### Requirement: Respect private or hidden positions
The extension MUST NOT treat hidden current positions by itself as a negative signal.

#### Scenario: Current position access unavailable
- **WHEN** the current position endpoint is unavailable or positions are hidden
- **THEN** the extension reports the missing data but does not penalize the trader solely for hidden positions
