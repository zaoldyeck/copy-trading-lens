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
  "src/content.js",
  "src/background.js",
  "src/popup.js",
  "src/content.css",
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

const jsFiles = [
  "src/i18n.js",
  "src/analysis.js",
  "src/providers.js",
  "src/content.js",
  "src/background.js",
  "src/popup.js",
  "scripts/generate-icons.mjs",
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
