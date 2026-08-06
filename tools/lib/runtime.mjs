// Runs the extension's own browser scripts (src/i18n.js, providers.js,
// analysis.js) inside a Node vm context, so CLI tooling shares exactly one
// implementation of "how to fetch/paginate Binance's copy-trade endpoints"
// and "how to score a lead trader" with the Chrome extension itself. Never
// re-implement that logic in a second language for a CLI convenience path —
// that's exactly the single-source-of-truth split this module exists to
// avoid (see CLAUDE.md §1.5).
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "../../src");
const LOCALES_DIR = path.join(__dirname, "../../_locales");
const SCRIPTS = ["i18n.js", "providers.js", "analysis.js"];

// i18n.js resolves every caution/verdict/strategy string through
// chrome.i18n.getMessage, which only exists inside a real extension. Stub it
// against the extension's own _locales/<lang>/messages.json so CLI output is
// the same human-readable text the extension renders — not a fifth
// reimplementation of the same translation table.
function loadLocaleDict(uiLang) {
  const dirName = uiLang.replace("-", "_"); // accept either "zh-TW" or "zh_TW"
  const file = path.join(LOCALES_DIR, dirName, "messages.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Create an isolated runtime with CopyTradingLensProviders/Analysis attached,
 * backed by Node's native fetch (real network calls, no browser required).
 * @param {{lang?: string, cookie?: string, uiLang?: string}} [opts]
 *   lang: `document.documentElement.lang`, sent to Binance as the `lang` request header (default "zh-TC").
 *   uiLang: which _locales/<uiLang> dict backs chrome.i18n.getMessage for output text (default "zh_TW").
 */
export function createRuntime(opts = {}) {
  const { lang = "zh-TC", cookie = "", uiLang = "zh_TW" } = opts;
  const localeDict = loadLocaleDict(uiLang);
  const sandbox = {
    console,
    fetch,
    URL,
    setTimeout,
    clearTimeout,
    document: {
      cookie,
      documentElement: { lang },
      body: { innerText: "" },
      title: ""
    },
    location: { href: "https://www.binance.com/" },
    chrome: localeDict
      ? {
        i18n: {
          getMessage: (key) => localeDict[key]?.message,
          getUILanguage: () => uiLang.replace("_", "-")
        }
      }
      : undefined
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  for (const file of SCRIPTS) {
    const code = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
    vm.runInContext(code, context, { filename: file });
  }

  return {
    providers: sandbox.CopyTradingLensProviders,
    analysis: sandbox.CopyTradingLensAnalysis,
    sandbox
  };
}
