import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supportedLocales = ["en", "zh_TW", "zh_CN", "ja"];
const requiredFiles = [
  "manifest.json",
  "popup.html",
  ...supportedLocales.map((locale) => `_locales/${locale}/messages.json`),
  "src/i18n.js",
  "src/analysis.js",
  "src/providers.js",
  "src/positions.js",
  "src/positions-panel.js",
  "src/content.js",
  "src/background.js",
  "src/popup.js",
  "src/content.css",
  "src/positions-panel.css",
  "src/popup.css",
  "assets/icons/icon16.png",
  "assets/icons/icon32.png",
  "assets/icons/icon48.png",
  "assets/icons/icon128.png",
  "README.md",
  "README.zh-TW.md",
  "README.zh-CN.md",
  "README.ja.md",
  "PRIVACY.md"
];

function fail(message) {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
}

for (const file of requiredFiles) {
  const path = join(root, file);
  if (!existsSync(path)) fail(`missing ${file}`);
  if (statSync(path).size <= 0) fail(`${file} is empty`);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (manifest.default_locale !== "en") fail("manifest default_locale must be en");
if (!manifest.name || !manifest.version || !manifest.description) fail("manifest must include name/version/description");
if (!String(manifest.name).startsWith("__MSG_")) fail("manifest name must use i18n __MSG_ substitution");
if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) fail("manifest must include content_scripts");
if (!Array.isArray(manifest.host_permissions)) fail("manifest must include host_permissions");
for (const host of manifest.host_permissions) {
  if (!["https://www.binance.com/*", "https://www.okx.com/*"].includes(host)) {
    fail(`unexpected host permission ${host}`);
  }
}
// A chrome.* API used without its permission fails silently at runtime — the
// call simply does nothing and the feature that depends on it dies quietly.
// Anything the extension actually calls must be declared here.
const declaredPermissions = new Set(manifest.permissions || []);
if (!declaredPermissions.has("storage")) {
  fail("src/background.js calls chrome.storage; the manifest must declare the storage permission");
}
for (const permission of declaredPermissions) {
  if (!["storage"].includes(permission)) fail(`unexpected permission ${permission}`);
}

const localeMessages = new Map();
for (const locale of supportedLocales) {
  const file = `_locales/${locale}/messages.json`;
  const messages = JSON.parse(readFileSync(join(root, file), "utf8"));
  localeMessages.set(locale, messages);
}
const defaultKeys = Object.keys(localeMessages.get("en")).sort();
for (const locale of supportedLocales.filter((name) => name !== "en")) {
  const keys = Object.keys(localeMessages.get(locale)).sort();
  const missing = defaultKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !defaultKeys.includes(key));
  if (missing.length || extra.length) {
    fail(`${locale} locale key mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
  }
}

// i18n.js interpolates {0}, {1}, ... itself and calls chrome.i18n.getMessage
// without a substitutions argument, so Chrome's native $1/$2 placeholders are
// never expanded — they reach the panel as the literal text "$1". A message
// that renders "adverse adds reach $1 layers" reads as a dollar amount, which
// is the worst possible failure mode in a risk panel.
const placeholderIndexes = (message) => [...new Set([...message.matchAll(/\{(\d+)\}/g)].map((match) => match[1]))].sort().join(",");
for (const locale of supportedLocales) {
  for (const [key, entry] of Object.entries(localeMessages.get(locale))) {
    const message = String(entry?.message ?? "");
    if (/\$\d/.test(message)) {
      fail(`${locale}/${key} uses Chrome-style $n placeholders; src/i18n.js only expands {n}`);
    }
    const expected = placeholderIndexes(String(localeMessages.get("en")[key]?.message ?? ""));
    const actual = placeholderIndexes(message);
    if (expected !== actual) {
      fail(`${locale}/${key} placeholder set [${actual}] differs from en [${expected}]`);
    }
  }
}

// A message key that is referenced but not defined renders as the raw key name
// in the panel — "posBadgeAtLeast" where a sentence should be. A key that is
// defined but never referenced is dead weight that survives every rename. Both
// are invisible until someone reads the UI in a language they do not speak, so
// they are checked here instead.
const uiSources = ["src/content.js", "src/positions-panel.js", "src/analysis.js", "src/popup.js"];
const referencedKeys = new Set();
for (const file of uiSources) {
  const text = readFileSync(join(root, file), "utf8");
  for (const match of text.matchAll(/["'`]([A-Za-z][A-Za-z0-9_]{2,})["'`]/g)) {
    referencedKeys.add(match[1]);
  }
}
const popupHtml = readFileSync(join(root, "popup.html"), "utf8");
for (const match of popupHtml.matchAll(/data-i18n=["']([^"']+)["']/g)) referencedKeys.add(match[1]);
const manifestText = readFileSync(join(root, "manifest.json"), "utf8");
for (const match of manifestText.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) referencedKeys.add(match[1]);

const definedKeys = new Set(defaultKeys);
const missing = [];
for (const file of uiSources) {
  const text = readFileSync(join(root, file), "utf8");
  for (const match of text.matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]/g)) {
    if (!definedKeys.has(match[1])) missing.push(`${file}: ${match[1]}`);
  }
}
if (missing.length) fail(`message keys used but not defined in _locales/en: ${missing.join(", ")}`);

const unused = defaultKeys.filter((key) => !referencedKeys.has(key));
if (unused.length) fail(`message keys defined but never referenced: ${unused.join(", ")}`);

const jsFiles = [
  "src/i18n.js",
  "src/analysis.js",
  "src/providers.js",
  "src/positions.js",
  "src/positions-panel.js",
  "src/content.js",
  "src/background.js",
  "src/popup.js",
  "scripts/generate-icons.mjs",
  "scripts/test-positions-panel-anchor.mjs",
  "scripts/validate-extension.mjs",
  "scripts/package-extension.mjs"
];
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) fail(`JavaScript syntax error in ${file}\n${result.stderr}`);
}

const forbiddenPatterns = [
  /csrftoken\s*[:=]\s*[A-Za-z0-9_-]{10,}/i,
  /aws-waf-token/i,
  /BNC_FV_KEY/i,
  /cookie\s*[:=]\s*[^,\n]+/i,
  /api[_-]?key\s*[:=]\s*['"][^'"]+/i
];
for (const file of requiredFiles.filter((name) => /\.(js|html|css|md|json)$/.test(name))) {
  const text = readFileSync(join(root, file), "utf8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) fail(`possible secret pattern in ${file}: ${pattern}`);
  }
}

console.log("Extension validation passed.");
