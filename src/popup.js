(function localizePopup() {
  "use strict";

  const i18n = window.CopyTradingLensI18n;
  if (!i18n) return;

  document.documentElement.lang = i18n.locale().replace("_", "-");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const key = node.getAttribute("data-i18n");
    if (!key) continue;
    node.textContent = i18n.t(key);
  }
})();
