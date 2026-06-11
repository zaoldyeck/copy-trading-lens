# lead-page-detection Specification

## Purpose
TBD - created by archiving change build-copy-trading-lens-extension. Update Purpose after archive.
## Requirements
### Requirement: Detect supported lead trader pages
The extension SHALL activate only on supported Binance and OKX lead trader detail pages and SHALL extract the current lead trader identifier from the URL.

#### Scenario: Binance lead page detected
- **WHEN** the active tab URL is `https://www.binance.com/.../copy-trading/lead-details/<portfolioId>`
- **THEN** the extension extracts `<portfolioId>` and labels the platform as Binance

#### Scenario: OKX lead page detected
- **WHEN** the active tab URL is `https://www.okx.com/.../copy-trading/account/<uniqueName>`
- **THEN** the extension extracts `<uniqueName>` and labels the platform as OKX

#### Scenario: Unsupported page ignored
- **WHEN** the active tab URL does not match a supported lead trader detail route
- **THEN** the extension does not inject the analysis overlay

### Requirement: Handle single-page-app navigation
The extension SHALL re-run page detection when Binance or OKX changes route through browser history without a full page reload.

#### Scenario: User navigates between lead traders
- **WHEN** the user navigates from one supported lead trader page to another in the same tab
- **THEN** the extension refreshes the active lead id and triggers a new analysis

### Requirement: Avoid static trader conclusions
The extension MUST NOT identify traders by a packaged recommendation database or show precomputed static conclusions as the analysis result.

#### Scenario: Known trader visited
- **WHEN** the user visits a lead trader that appeared in prior local research
- **THEN** the extension still fetches current page data and computes a fresh analysis

