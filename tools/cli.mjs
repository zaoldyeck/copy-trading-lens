#!/usr/bin/env node
// Research CLI for copy-trading-lens: fetch/analyze/rank Binance lead
// traders from the terminal, reusing the exact same src/providers.js +
// src/analysis.js the Chrome extension runs. See tools/README.md.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./lib/runtime.mjs";
import { fetchAndAnalyze, fetchTrader } from "./lib/fetch-trader.mjs";
import { runBatch } from "./lib/batch.mjs";
import { rankedAbove } from "./lib/ranking.mjs";
import { summarizeResult, toMarkdownTable } from "./lib/report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = __dirname;
const REPORTS_DIR = path.join(__dirname, "../reports");

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function cmdFetch(positional) {
  const [platform, id] = positional;
  if (!platform || !id) throw new Error("usage: fetch <Binance|OKX> <portfolioId>");
  const runtime = createRuntime();
  const { raw, cached } = await fetchTrader(runtime, { platform, id }, { baseDir: BASE_DIR });
  console.log(`${cached ? "cached" : "fetched"}: ${raw.detail?.nickname || raw.candidate?.nickName || id}`);
  console.log(`  positions=${raw.positionHistory.length} orders=${raw.orderHistory.length} transfers=${raw.transferHistory.length}`);
}

async function cmdAnalyze(positional, flags) {
  const [platform, id] = positional;
  if (!platform || !id) throw new Error("usage: analyze <Binance|OKX> <portfolioId>");
  const runtime = createRuntime({ uiLang: flags.lang || "zh_TW" });
  const { result } = await fetchAndAnalyze(runtime, { platform, id }, { baseDir: BASE_DIR, force: Boolean(flags.force) });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRankAbove(positional, flags) {
  const [targetId] = positional;
  if (!targetId) throw new Error("usage: rank-above <targetPortfolioId> [--timeRange 30D] [--minDays 30] [--pageSize 20]");
  const runtime = createRuntime();
  const opts = {
    timeRange: flags.timeRange || "30D",
    pageSize: Number(flags.pageSize) || 20,
    minDaysTrading: flags.minDays !== undefined ? Number(flags.minDays) : 30
  };
  const { found, targetRank, above } = await rankedAbove(runtime, targetId, opts);
  if (!found) {
    console.error(`target ${targetId} not found in ranking (checked ${above.length} entries) — check filters/timeRange`);
    process.exitCode = 1;
  } else {
    console.error(`target is rank ${targetRank}; ${above.length} traders ranked above it`);
  }
  console.log(JSON.stringify(above.map((a) => ({ rank: a.rank, portfolioId: String(a.leadPortfolioId), nickname: a.nickname, roi: a.roi })), null, 2));
}

async function cmdReport(positional, flags) {
  const [listFile] = positional;
  if (!listFile) throw new Error("usage: report <ranking.json> [--out reports/name.md] [--concurrency 5] [--lang zh_TW]");
  const entries = JSON.parse(fs.readFileSync(listFile, "utf8"));
  const runtime = createRuntime({ uiLang: flags.lang || "zh_TW" });
  const concurrency = Number(flags.concurrency) || 5;

  const results = await runBatch(
    entries,
    async (entry) => {
      const { result } = await fetchAndAnalyze(runtime, { platform: "Binance", id: entry.portfolioId }, { baseDir: BASE_DIR });
      return summarizeResult(entry, result);
    },
    {
      concurrency,
      onResult: (entry, _result, error) => {
        console.error(error ? `[${entry.rank}] ${entry.nickname} FAILED: ${error.message}` : `[${entry.rank}] ${entry.nickname} OK`);
      }
    }
  );

  const summaries = results.filter((r) => r.ok).map((r) => r.result);
  const failures = results.filter((r) => !r.ok).map((r) => ({ rank: r.item.rank, nickname: r.item.nickname, portfolioId: r.item.portfolioId, error: r.error }));

  const table = toMarkdownTable(summaries, { sortBy: "verdict" });
  const md = [
    `# 跟單排行分析報告`,
    ``,
    `產生時間：${new Date().toISOString()}　候選人數：${entries.length}　成功分析：${summaries.length}　失敗：${failures.length}`,
    ``,
    table,
    ``,
    failures.length ? `## 抓取失敗\n\n${failures.map((f) => `- [${f.rank}] ${f.nickname} (${f.portfolioId}): ${f.error}`).join("\n")}` : ""
  ].join("\n");

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = flags.out ? path.resolve(flags.out) : path.join(REPORTS_DIR, `ranking-${Date.now()}.md`);
  fs.writeFileSync(outPath, md);
  fs.writeFileSync(outPath.replace(/\.md$/, ".json"), JSON.stringify({ summaries, failures }, null, 2));
  console.error(`\nwrote ${outPath}`);
}

const [, , cmd, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);

const commands = {
  fetch: cmdFetch,
  analyze: cmdAnalyze,
  "rank-above": cmdRankAbove,
  report: cmdReport
};

const handler = commands[cmd];
if (!handler) {
  console.error(`usage: node tools/cli.mjs <${Object.keys(commands).join("|")}> ...`);
  console.error(`see tools/README.md for details`);
  process.exit(1);
}

try {
  await handler(positional, flags);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
