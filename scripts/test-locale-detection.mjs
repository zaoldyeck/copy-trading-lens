// Which language the extension speaks decides every sentence the user reads, so the order of evidence is fixed
// (AGENTS.md invariant 10): the URL's language segment, then the page's own <html lang> (what the user is reading),
// then Binance's language cookie, then the browser. A browser set to English must not override a Traditional
// Chinese page that has no language segment in its URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/i18n.js"), "utf8");

function detect({ pathname = "/copy-trading/x", htmlLang = "", cookie = "", browser = "" } = {}) {
  const sandbox = {
    location: { pathname },
    document: { documentElement: { lang: htmlLang }, cookie },
    navigator: { language: browser },
    chrome: undefined
  };
  return new Function("globalThis", `${source}\nreturn globalThis.CopyTradingLensI18n.detectLocale();`)(sandbox);
}

const cases = [
  [{ pathname: "/zh-TC/copy-trading/x" }, "zh_TW", "URL segment zh-TC"],
  [{ pathname: "/zh-MO/copy-trading/x" }, "zh_TW", "URL segment zh-MO"],
  [{ pathname: "/zh-SG/copy-trading/x" }, "zh_CN", "URL segment zh-SG"],
  [{ pathname: "/ja/copy-trading/x", htmlLang: "en" }, "ja", "URL beats html lang"],
  [{ htmlLang: "zh-TC", browser: "en-US" }, "zh_TW", "html lang beats the browser language"],
  [{ htmlLang: "zh_CN", cookie: "lang=en" }, "zh_CN", "html lang beats the cookie"],
  [{ cookie: "bapi_lang=zh-TC; other=1", browser: "en-US" }, "zh_TW", "bapi_lang cookie beats the browser"],
  [{ cookie: "lang=ja", browser: "en-US" }, "ja", "lang cookie"],
  [{ cookie: "lang=zh-MO" }, "zh_TW", "cookie zh-MO"],
  [{ browser: "zh-HK" }, "zh_TW", "browser language is the last resort"],
  [{}, "en", "nothing known: English"]
];
for (const [input, want, name] of cases) assert.equal(detect(input), want, name);
console.log(`PASS: language evidence is read in a fixed order (${cases.length} cases)`);
