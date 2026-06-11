## ADDED Requirements

### Requirement: Provide Manifest V3 package
The project SHALL provide a Chrome Manifest V3 extension package with required manifest fields, icons, content scripts, popup, and host permissions limited to supported exchange sites.

#### Scenario: Package validation runs
- **WHEN** the validation script is executed
- **THEN** it confirms manifest version, required files, icon files, content scripts, and zip root structure

### Requirement: Provide public documentation
The project SHALL include README, privacy policy, and Chrome Web Store description text suitable for a public GitHub repository and Chrome Web Store submission.

#### Scenario: User reviews GitHub repo
- **WHEN** a user opens the repository README
- **THEN** they can understand what the extension does, what data it uses, how to install locally, how to package it, and what it does not collect

### Requirement: Exclude secrets and private data
The package MUST NOT include private headers, cookies, API keys, local data caches, raw exchange snapshots, or prior static trader recommendation databases.

#### Scenario: Build package created
- **WHEN** the package script creates the Chrome Web Store zip
- **THEN** the zip excludes local-only files and contains no known secret/cache file patterns

### Requirement: Support GitHub publication
The repository SHALL be initialized as a clean git repository and be ready to push to a public GitHub remote without including private source material.

#### Scenario: Public repo prepared
- **WHEN** the project is pushed to GitHub
- **THEN** only extension source, OpenSpec artifacts, docs, validation scripts, and generated icons are tracked
