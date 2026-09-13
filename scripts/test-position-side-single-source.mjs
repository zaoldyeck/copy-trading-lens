// Guard: what a fill does to a position (open, close, flip) is decided only in
// src/positions.js (stepBook / replayPositions). Every other interpretation of
// an order's positionSide has, so far, dropped one-way ("BOTH") flips:
// style.js rebuilt one trader's 48 positions as 4 (2026-09-13), and
// analysis.js guessed "totalPnl == 0 means opening".
//
// This test fails when any shipped file outside positions.js reads
// `.positionSide`, unless that exact line is allowlisted below with the reason
// it is not interpreting an order fill.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "src/positions.js";
const SCANNED_DIRS = ["src"];
const ALLOWED = [
  // position-history rows carry a direction, not an order's book
  { file: "src/analysis.js", pattern: /position\.positionSide/ }
];

function filesUnder(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(rel);
    return /\.(m?js)$/.test(entry.name) ? [rel] : [];
  });
}

// Handing the raw field to the owner's own key function is the sanctioned
// path, not an interpretation: every `.positionSide` on the line must sit
// inside a bucketKeyOf(...) call.
function onlyPassedToOwner(line) {
  const reads = [...line.matchAll(/\.positionSide\b/g)].map((match) => match.index);
  if (!reads.length) return false;
  const calls = [];
  for (const match of line.matchAll(/bucketKeyOf\(/g)) {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < line.length; i += 1) {
      if (line[i] === "(") depth += 1;
      else if (line[i] === ")" && --depth === 0) {
        calls.push([match.index, i]);
        break;
      }
    }
  }
  return reads.every((at) => calls.some(([start, end]) => at > start && at < end));
}

function violationsIn(file, text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    if (!/\.positionSide\b/.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (onlyPassedToOwner(line)) return;
    if (ALLOWED.some((rule) => rule.file === file && rule.pattern.test(line))) return;
    found.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return found;
}

// The guard must still catch the two shapes that actually shipped.
assert.equal(violationsIn("src/x.js", 'const positionSide = String(firstDefined(order.positionSide, "BOTH")).toUpperCase();').length, 1);
assert.equal(violationsIn("src/x.js", "const key = Positions.bucketKeyOf(symbol, order.positionSide) + order.positionSide;").length, 1);
assert.equal(violationsIn("src/x.js", "const key = Positions.bucketKeyOf(String(order.symbol), order.positionSide);").length, 0);

const violations = SCANNED_DIRS.flatMap(filesUnder)
  .filter((file) => file !== OWNER)
  .flatMap((file) => violationsIn(file, fs.readFileSync(path.join(root, file), "utf8")));

assert.deepEqual(violations, [], `order positionSide read outside ${OWNER}; use CopyTradingLensPositions.stepBook / replayPositions:\n${violations.join("\n")}`);
console.log("ok   order fills are interpreted only in src/positions.js");
