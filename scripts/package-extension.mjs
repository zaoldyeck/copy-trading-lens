import { mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const staging = join(dist, "copy-trading-lens");
const manifest = await import(`file://${join(root, "manifest.json")}`, { with: { type: "json" } });
const version = manifest.default.version;
const zipPath = join(dist, `copy-trading-lens-${version}.zip`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const entry of ["manifest.json", "popup.html", "assets", "src"]) {
  cpSync(join(root, entry), join(staging, entry), { recursive: true });
}

if (existsSync(zipPath)) rmSync(zipPath);
const result = spawnSync("zip", ["-r", zipPath, "."], {
  cwd: staging,
  encoding: "utf8"
});
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status || 1);
}

console.log(`Created ${zipPath}`);
