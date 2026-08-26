(function attachHotReload() {
  "use strict";

  // Development-only reload of the unpacked extension when its files change.
  //
  // This used to poll with a self-rescheduling setTimeout chain. Under MV3 that
  // cannot work: the service worker is suspended after ~30 s idle and every
  // pending timer dies with it, so the watcher stopped after the first idle
  // window and never announced that it had — edits silently stopped reaching the
  // browser and the only symptom was "my change isn't showing".
  //
  // The check is now driven by the one event that actually matters: a content
  // script loading on a supported page. That wakes the worker by definition, and
  // it is exactly the moment a stale build would be about to run.

  const STORAGE_KEY = "ctlPackageTimestamp";
  const PENDING_TAB_KEY = "ctlPendingTabReload";
  const isDev = !("update_url" in chrome.runtime.getManifest());
  if (!isDev) return;

  function filesInDirectory(dir) {
    return new Promise((resolve) =>
      dir.createReader().readEntries((entries) =>
        Promise.all(
          entries
            .filter((entry) => !entry.name.startsWith(".") && entry.name !== "dist")
            .map((entry) =>
              entry.isDirectory
                ? filesInDirectory(entry)
                : new Promise((resolveFile) => entry.file(resolveFile))
            )
        ).then((files) => resolve(files.flat()))
      )
    );
  }

  function packageTimestamp() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.getPackageDirectoryEntry?.((dir) => {
          if (!dir) {
            resolve("");
            return;
          }
          filesInDirectory(dir)
            .then((files) => resolve(files.map((file) => file.name + (file.lastModified || 0)).join()))
            .catch(() => resolve(""));
        });
      } catch (_error) {
        resolve("");
      }
    });
  }

  async function reloadIfChanged(tabId) {
    const timestamp = await packageTimestamp();
    if (!timestamp) return;
    // Session storage, not a module variable: the worker is torn down between
    // events, so anything held in memory is gone by the next check and every
    // load would look like a change.
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const previous = stored?.[STORAGE_KEY];
    if (previous === timestamp) return;
    await chrome.storage.session.set({ [STORAGE_KEY]: timestamp });
    if (previous === undefined) return; // first sighting is the baseline, not a change
    // The tab has to be reloaded AFTER the extension restarts, not before:
    // chrome.runtime.reload() does not re-inject content scripts into open tabs,
    // so reloading the tab first would just re-run the stale build. Hand the tab
    // id to the next worker instance through local storage, which survives the
    // restart (session storage does not — which is also what stops this from
    // looping, since the timestamp baseline is re-established from scratch).
    if (tabId !== undefined) await chrome.storage.local.set({ [PENDING_TAB_KEY]: tabId });
    chrome.runtime.reload();
  }

  async function finishPendingReload() {
    const stored = await chrome.storage.local.get(PENDING_TAB_KEY);
    const tabId = stored?.[PENDING_TAB_KEY];
    if (tabId === undefined) return;
    await chrome.storage.local.remove(PENDING_TAB_KEY);
    try {
      await chrome.tabs.reload(tabId);
    } catch (_error) {
      // The tab may be gone by now; nothing to reload.
    }
  }

  finishPendingReload();

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "ctl:content-loaded") return false;
    reloadIfChanged(sender.tab?.id);
    return false;
  });
})();
