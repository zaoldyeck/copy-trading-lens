(function attachCopyTradingLensI18n(global) {
  "use strict";

  function normalizeSubstitutions(substitutions) {
    if (substitutions === undefined || substitutions === null) return [];
    return Array.isArray(substitutions) ? substitutions : [substitutions];
  }

  function interpolate(message, substitutions) {
    const values = normalizeSubstitutions(substitutions);
    return String(message).replace(/\{(\d+)\}/g, (_, index) => {
      const value = values[Number(index)];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  function message(key, substitutions) {
    let localized = "";
    try {
      localized = global.chrome?.i18n?.getMessage?.(key) || "";
    } catch (_error) {
      localized = "";
    }
    return interpolate(localized || key, substitutions);
  }

  function uiLocale() {
    try {
      return global.chrome?.i18n?.getUILanguage?.() || message("@@ui_locale") || "en";
    } catch (_error) {
      return "en";
    }
  }

  global.CopyTradingLensI18n = {
    t: message,
    locale: uiLocale
  };
})(globalThis);
