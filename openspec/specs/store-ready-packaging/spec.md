# store-ready-packaging Specification

## Purpose
Defines the public repository, documentation, validation, packaging, release, and licensing requirements for the extension.
## Requirements
### Requirement: Provide Manifest V3 package
The project SHALL provide a Chrome Manifest V3 extension package with required manifest fields, icons, content scripts, popup, and host permissions limited to supported exchange sites.

#### Scenario: Package validation runs
- **WHEN** the validation script is executed
- **THEN** it confirms manifest version, required files, icon files, content scripts, and zip root structure

### Requirement: Provide public documentation
The project SHALL include user-facing README files and a privacy policy suitable for a public GitHub repository.

#### Scenario: User reviews GitHub repo
- **WHEN** a user opens the repository README
- **THEN** they can understand what the extension does, what data it uses, how to install locally, how to package it, and what it does not collect

### Requirement: Exclude secrets and private data
The package MUST NOT include private headers, cookies, API keys, local data caches, raw exchange snapshots, prior static trader recommendation databases, root task ledgers, internal publishing instructions, or personal payment details.

#### Scenario: Build package created
- **WHEN** the package script creates the Chrome Web Store zip
- **THEN** the zip excludes local-only files and contains no known secret/cache file patterns

### Requirement: Support GitHub publication
The repository SHALL be initialized as a clean git repository and be ready to push to a public GitHub remote without including private source material.

#### Scenario: Public repo prepared
- **WHEN** the project is pushed to GitHub
- **THEN** only extension source, OpenSpec artifacts, public docs, validation scripts, release workflow, and generated icons are tracked

### Requirement: Package localized extension files
The package script SHALL include `_locales` and all localized popup/content assets in the generated extension ZIP.

#### Scenario: Extension ZIP is generated
- **WHEN** the package command completes
- **THEN** the ZIP contains `manifest.json`, `_locales/en/messages.json`, `_locales/zh_TW/messages.json`, `_locales/zh_CN/messages.json`, `_locales/ja/messages.json`, popup files, content scripts, styles, and icons at the ZIP root

### Requirement: Publish GitHub release packages
The repository SHALL provide a GitHub Actions workflow that builds the extension ZIP and attaches it to tagged GitHub Releases.

#### Scenario: Version tag is pushed
- **WHEN** a `v*` tag is pushed
- **THEN** CI validates the extension, builds `dist/copy-trading-lens-*.zip`, and uploads the ZIP to the GitHub Release

### Requirement: Use non-commercial attribution license
The repository SHALL use a license that permits copying and modification with attribution while prohibiting commercial use without separate permission.

#### Scenario: User reads the license
- **WHEN** a user opens `LICENSE`
- **THEN** the license clearly states attribution is required, adaptations are allowed, and commercial use is not allowed

### Requirement: Keep publishing guide local-only
The repository MUST NOT track Chrome Web Store owner submission guides, private publishing checklists, store account details, payout details, or personal donation addresses.

#### Scenario: Public repo is reviewed
- **WHEN** a developer opens the GitHub repository
- **THEN** they see extension source, public docs, specs, and validation scripts, but no private Chrome Web Store submission guide or personal publishing/account details

### Requirement: Validate locale parity
The validation script SHALL verify that every supported locale file exists and contains the same message keys as the default English locale.

#### Scenario: Locale file is missing a message
- **WHEN** validation runs with a supported locale missing a message key
- **THEN** validation fails before packaging

### Requirement: Provide multilingual public documentation
The repository SHALL provide an English default README plus Taiwan Traditional Chinese, Simplified Chinese, and Japanese README files with equivalent installation, packaging, privacy, limitations, licensing, donation, and repository-layout information.

#### Scenario: Public GitHub visitor opens repository
- **WHEN** a visitor opens `README.md`
- **THEN** they see English documentation and links to the Taiwan Traditional Chinese, Simplified Chinese, and Japanese README files

#### Scenario: Localized user needs documentation
- **WHEN** a user opens a localized README
- **THEN** they see equivalent localized usage, installation, privacy, limitation, license, and support information without private publishing instructions
