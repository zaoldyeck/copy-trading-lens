// Guard: an order-history row's time is read only through
// CopyTradingLensPositions.fillTimeOf (src/positions.js). The row carries two
// clocks — orderTime (placed) and orderUpdateTime (filled) — and reading the
// placement clock as a fill replayed resting take-profits before the entries
// they closed: style.js and analysis.js did exactly that until 2026-09-15.
//
// Fails when shipped code reads `.orderTime` anywhere, or `.orderUpdateTime`
// outside fillTimeOf. Comments are not code and are skipped.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(rel);
    return /\.(m?js)$/.test(entry.name) ? [rel] : [];
  });
}

const violations = [];
for (const file of filesUnder("src")) {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  let insideFillTimeOf = false;
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/function fillTimeOf\(/.test(code)) insideFillTimeOf = file === "src/positions.js";
    if (/\.orderTime\b|["']orderTime["']/.test(code)) violations.push(`${file}:${index + 1}: reads the placement clock: ${line.trim()}`);
    if (/\.orderUpdateTime\b|["']orderUpdateTime["']/.test(code) && !insideFillTimeOf) {
      violations.push(`${file}:${index + 1}: reads the fill clock outside fillTimeOf: ${line.trim()}`);
    }
    if (insideFillTimeOf && /^\s*}\s*$/.test(code)) insideFillTimeOf = false;
  });
}

// The guard must be able to fail: the line analysis.js carried before the fix.
const sample = 'const sorted = [...orders].sort((a, b) => num(a.orderTime, 0) - num(b.orderTime, 0));';
assert.ok(/\.orderTime\b/.test(sample.replace(/\/\/.*$/, "")), "the pattern catches the pre-fix analysis.js line");

assert.deepEqual(violations, [], `order time read outside fillTimeOf:\n${violations.join("\n")}`);
console.log("PASS: order-history time is read only through fillTimeOf");
