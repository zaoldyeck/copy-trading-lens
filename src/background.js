(function attachHotReload() {
  "use strict";

  // Only enable hot-reload in development (unpacked) extensions
  const isDev = !("update_url" in chrome.runtime.getManifest());
  if (!isDev) return;

  function filesInDirectory(dir) {
    return new Promise((resolve) =>
      dir.createReader().readEntries((entries) =>
        Promise.all(
          entries
            .filter((e) => !e.name.startsWith(".") && e.name !== "dist")
            .map((e) =>
              e.isDirectory
                ? filesInDirectory(e)
                : new Promise((res) => e.file(res))
            )
        ).then((files) => resolve(files.flat()))
      )
    );
  }

  function timestampForFilesInDirectory(dir) {
    return filesInDirectory(dir).then((files) =>
      files.map((f) => f.name + (f.lastModified || f.lastModifiedDate || "")).join()
    );
  }

  function reload() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].url && (tabs[0].url.includes("binance.com") || tabs[0].url.includes("okx.com"))) {
          chrome.tabs.reload(tabs[0].id);
        }
        chrome.runtime.reload();
      });
    } catch (_e) {
      chrome.runtime.reload();
    }
  }

  function watchChanges(dir, lastTimestamp) {
    timestampForFilesInDirectory(dir)
      .then((timestamp) => {
        if (!lastTimestamp || lastTimestamp === timestamp) {
          setTimeout(() => watchChanges(dir, timestamp), 1000);
        } else {
          reload();
        }
      })
      .catch(() => {
        setTimeout(() => watchChanges(dir, lastTimestamp), 2000);
      });
  }

  try {
    chrome.runtime.getPackageDirectoryEntry?.((dir) => {
      if (dir) watchChanges(dir);
    });
  } catch (_e) {
    // fallback if getPackageDirectoryEntry is unavailable
  }
})();
