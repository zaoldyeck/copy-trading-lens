# analysis-overlay-ui Specification

## Purpose
Defines the in-page overlay and popup behavior for follower-facing copy-trading risk analysis, including localized labels, actionable evidence, data status, and non-investment-advice constraints.
## Requirements
### Requirement: Render analysis overlay
The extension SHALL render a page overlay on supported lead trader pages showing the current trader, platform, verdict, strategy family, key metrics, risk evidence, performance source, annualized return, standard window cross-checks, and data status.

#### Scenario: Analysis succeeds
- **WHEN** data fetching and local analysis complete
- **THEN** the overlay displays the verdict, strategy family, core metrics, annualized return, caution list, positive list, performance source, standard performance windows, and dataset counts

#### Scenario: Analysis fails
- **WHEN** provider fetching or analysis fails
- **THEN** the overlay displays a readable failure state with a retry action

#### Scenario: Annualized return unavailable
- **WHEN** annualized return cannot be computed from reconstructed or window performance
- **THEN** the overlay displays `N/A` rather than zero

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

### Requirement: Localize extension UI
The extension SHALL display overlay, popup, manifest, and analysis verdict text in the Chrome UI locale when a supported locale is available, with English as the default fallback locale.

#### Scenario: Chrome UI locale is Taiwan Traditional Chinese
- **WHEN** Chrome's UI locale resolves to `zh_TW`
- **THEN** the extension displays Taiwan Traditional Chinese UI labels, verdict titles, risk messages, popup text, and manifest metadata

#### Scenario: Chrome UI locale is English or unsupported
- **WHEN** Chrome's UI locale is English or no supported locale exists
- **THEN** the extension displays English text from the default locale

### Requirement: Preserve exchange-provided values
The extension MUST NOT translate trader names, symbols, exchange-provided descriptions, URLs, API field names, or raw debug JSON values.

#### Scenario: Trader description is returned by the exchange
- **WHEN** a trader profile contains text in Chinese, English, or another language
- **THEN** the extension displays or analyzes the value as-is and only localizes extension-owned labels around it
