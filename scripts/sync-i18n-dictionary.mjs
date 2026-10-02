import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const locales = ["en", "zh_TW", "zh_CN", "ja"];
const dict = {};

for (const loc of locales) {
  const data = JSON.parse(readFileSync(join(root, `_locales/${loc}/messages.json`), "utf8"));
  dict[loc] = {};
  for (const [k, v] of Object.entries(data)) {
    dict[loc][k] = v.message;
  }
}

const template = `(function attachCopyTradingLensI18n(global) {
  "use strict";

  const DICTIONARIES = ${JSON.stringify(dict, null, 2)};

  function detectLocale() {
    try {
      const path = global.location?.pathname || "";
      if (path.includes("/zh-TC") || path.includes("/zh-TW") || path.includes("/zh-HK") || path.includes("/zh-Hant") || path.includes("/zh-MO")) {
        return "zh_TW";
      }
      if (path.includes("/zh-CN") || path.includes("/zh-Hans") || path.includes("/zh-SG") || path.includes("/zh/")) {
        return "zh_CN";
      }
      if (path.includes("/ja")) {
        return "ja";
      }
      if (path.includes("/en")) {
        return "en";
      }

      const htmlLang = global.document?.documentElement?.lang || "";
      if (/^zh[-_](?:TW|HK|MO|Hant|TC)/i.test(htmlLang)) return "zh_TW";
      if (/^zh[-_](?:CN|Hans|SG|SC)/i.test(htmlLang)) return "zh_CN";
      if (/^ja/i.test(htmlLang)) return "ja";
      if (/^en/i.test(htmlLang)) return "en";

      const rawCk = (global.document && global.document.cookie) || "";
      const cookieMatch = rawCk.match(/(?:^|;\\s*)(?:lang|bapi_lang)=([^;]+)/);
      if (cookieMatch) {
        const val = decodeURIComponent(cookieMatch[1]).toLowerCase();
        if (val.includes("tc") || val.includes("tw") || val.includes("hk") || val.includes("hant") || val.includes("mo")) return "zh_TW";
        if (val.includes("cn") || val.includes("hans") || val.includes("sg") || val === "zh") return "zh_CN";
        if (val.includes("ja")) return "ja";
        if (val.includes("en")) return "en";
      }

      const browserLang = global.chrome?.i18n?.getUILanguage?.() || global.navigator?.language || "";
      if (/^zh[-_](?:TW|HK|MO|Hant|TC)/i.test(browserLang)) return "zh_TW";
      if (/^zh[-_](?:CN|Hans|SG|SC)/i.test(browserLang)) return "zh_CN";
      if (/^zh/i.test(browserLang)) return "zh_TW"; // Default Chinese fallback to zh_TW
      if (/^ja/i.test(browserLang)) return "ja";
      if (/^en/i.test(browserLang)) return "en";
    } catch (_e) {}

    return "en";
  }

  function normalizeSubstitutions(substitutions) {
    if (substitutions === undefined || substitutions === null) return [];
    return Array.isArray(substitutions) ? substitutions : [substitutions];
  }

  function interpolate(message, substitutions) {
    const values = normalizeSubstitutions(substitutions);
    return String(message).replace(/\\{(\\d+)\\}/g, (_, index) => {
      const value = values[Number(index)];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  function message(key, substitutions) {
    const locale = detectLocale();
    let localized = DICTIONARIES[locale]?.[key];
    if (!localized) {
      try {
        localized = global.chrome?.i18n?.getMessage?.(key) || "";
      } catch (_error) {
        localized = "";
      }
    }
    if (!localized) {
      localized = DICTIONARIES.en?.[key] || key;
    }
    return interpolate(localized, substitutions);
  }

  function uiLocale() {
    return detectLocale();
  }

  global.CopyTradingLensI18n = {
    t: message,
    locale: uiLocale,
    detectLocale
  };
})(globalThis);
`;

writeFileSync(join(root, "src/i18n.js"), template, "utf8");
console.log("Synced i18n dictionaries to src/i18n.js successfully.");
