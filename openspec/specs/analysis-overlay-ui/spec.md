# analysis-overlay-ui Specification

## Purpose
TBD - created by archiving change build-copy-trading-lens-extension. Update Purpose after archive.
## Requirements
### Requirement: Render analysis overlay
The extension SHALL render a page overlay on supported lead trader pages showing the current trader, platform, verdict, strategy family, key metrics, risk evidence, performance source, standard window cross-checks, and data status.

#### Scenario: Analysis succeeds
- **WHEN** data fetching and local analysis complete
- **THEN** the overlay displays the verdict, strategy family, core metrics, caution list, positive list, performance source, standard performance windows, and dataset counts

#### Scenario: Analysis fails
- **WHEN** provider fetching or analysis fails
- **THEN** the overlay displays a readable failure state with a retry action

### Requirement: Keep UI non-invasive
The extension SHALL keep the overlay collapsible and avoid blocking the exchange page's trading controls.

#### Scenario: User collapses overlay
- **WHEN** the user clicks the collapse control
- **THEN** the overlay shrinks to a small launcher without covering the main page content

### Requirement: Provide actionable copy-trading guidance
The overlay SHALL include practical setup guidance focused on follower safety, including avoiding immediate copy of existing positions when risky, using fixed ratio copy where supported, and using account-level stop loss.

#### Scenario: Current floating loss detected
- **WHEN** current positions contain material unrealized losses
- **THEN** the overlay warns against copying existing positions immediately

### Requirement: Avoid investment guarantees
The UI MUST NOT claim guaranteed profit, guaranteed safety, or definitive detection of every bad trader.

#### Scenario: Followable verdict displayed
- **WHEN** a trader receives a favorable or observation verdict
- **THEN** the overlay phrases it as small-ratio observation or followability, not guaranteed profit

#### Scenario: Metric unavailable
- **WHEN** ROI, MDD, or all-period reconstruction is unavailable
- **THEN** the overlay displays `N/A` and an explanatory source label instead of showing zero

