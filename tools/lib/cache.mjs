// Disk cache for fetched trader data, keyed by portfolioId. Raw API payloads
// are large and ephemeral (a trader's true state at fetch time) — cached so
// repeated CLI runs (e.g. iterating on report formatting) don't re-hit
// Binance, but the cache itself is gitignored, not a source-of-truth.
import fs from "node:fs";
import path from "node:path";

export function cacheDir(baseDir) {
  const dir = path.join(baseDir, "cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rawPath(baseDir, portfolioId) {
  return path.join(cacheDir(baseDir), `raw_${portfolioId}.json`);
}

export function hasCachedRaw(baseDir, portfolioId) {
  return fs.existsSync(rawPath(baseDir, portfolioId));
}

export function readCachedRaw(baseDir, portfolioId) {
  return JSON.parse(fs.readFileSync(rawPath(baseDir, portfolioId), "utf8"));
}

export function writeCachedRaw(baseDir, portfolioId, raw) {
  fs.writeFileSync(rawPath(baseDir, portfolioId), JSON.stringify(raw));
}
