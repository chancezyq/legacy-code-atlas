#!/usr/bin/env node

import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { analyzeProjectDetailed } from "../src/analyzer.mjs";
import { writeFileAtomic } from "../src/atomic-write.mjs";
import { cacheEntriesFromResults, loadFileCache, saveFileCache } from "../src/cache.mjs";
import { serializeGraph } from "../src/graph.mjs";
import { searchGraph, traceFeature, traceProcedure, traceStatement, traceTable, traceUrl } from "../src/query.mjs";
import { renderTraceMarkdown } from "../src/render.mjs";

const HELP = `Legacy Code Atlas

Usage:
  legacy-code-atlas analyze <project> [--output <index.json>] [--json]
  legacy-code-atlas overview <project-or-index> [--json]
  legacy-code-atlas search <project-or-index> <term> [--json]
  legacy-code-atlas trace-feature <project-or-index> <term> [--json]
  legacy-code-atlas trace-url <project-or-index> <url> [--json]
  legacy-code-atlas trace-statement <project-or-index> <statement-id> [--json]
  legacy-code-atlas trace-procedure <project-or-index> <procedure> [--json]
  legacy-code-atlas trace-table <project-or-index> <table> [--json]
`;

function parseArguments(argv) {
  const positional = [];
  let json = false;
  let output = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") json = true;
    else if (argv[index] === "--output") {
      output = argv[index + 1] ?? "";
      index += 1;
    } else positional.push(argv[index]);
  }
  return { positional, json, output };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeIndex(graph, outputPath) {
  await writeFileAtomic(outputPath, serializeGraph(graph));
}

async function loadGraph(input) {
  const absolute = path.resolve(input);
  const metadata = await stat(absolute);
  if (metadata.isFile()) return JSON.parse(await readFile(absolute, "utf8"));
  const indexPath = path.join(absolute, ".legacy-code-atlas", "index.json");
  if (await exists(indexPath)) return JSON.parse(await readFile(indexPath, "utf8"));
  const cachePath = path.join(absolute, ".legacy-code-atlas", "cache.json");
  const cached = await loadFileCache(cachePath);
  const detailed = await analyzeProjectDetailed(absolute, {
    cached,
    cacheWriter: (results, { signal }) => saveFileCache(
      cachePath,
      cacheEntriesFromResults(results),
      { signal },
    ),
  });
  const graph = detailed.graph;
  await writeIndex(graph, indexPath);
  return graph;
}

function renderOverview(graph) {
  const lines = [
    "# 项目概览",
    "",
    `- 根目录：${graph.project.root}`,
    `- 节点：${graph.summary.nodes}`,
    `- 关系：${graph.summary.edges}`,
    "",
    "## 节点类型",
    "",
    ...Object.entries(graph.summary.nodeTypes).map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## 关系类型",
    "",
    ...Object.entries(graph.summary.edgeTypes).map(([type, count]) => `- ${type}: ${count}`),
  ];
  return `${lines.join("\n")}\n`;
}

function renderSearch(results, query) {
  const lines = [`# 搜索：${query}`, ""];
  if (results.length === 0) lines.push("未找到匹配节点。");
  else for (const result of results) {
    const evidence = result.evidence?.[0];
    lines.push(`- ${result.id}（score ${result.score}）${evidence ? `；${evidence.file}:${evidence.line}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { positional, json, output } = parseArguments(process.argv.slice(2));
  const [command, input, ...queryParts] = positional;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!input) throw new Error(`命令 ${command} 缺少项目或索引路径`);

  if (command === "analyze") {
    const project = path.resolve(input);
    const outputPath = path.resolve(output || path.join(project, ".legacy-code-atlas", "index.json"));
    const cachePath = path.join(project, ".legacy-code-atlas", "cache.json");
    const cached = await loadFileCache(cachePath);
    const detailed = await analyzeProjectDetailed(project, {
      cached,
      cacheWriter: (results, { signal }) => saveFileCache(
        cachePath,
        cacheEntriesFromResults(results),
        { signal },
      ),
    });
    const graph = detailed.graph;
    await writeIndex(graph, outputPath);
    if (json) process.stdout.write(serializeGraph(graph));
    else process.stdout.write(`分析完成：${graph.summary.nodes} 个节点，${graph.summary.edges} 条关系\n索引：${outputPath}\n`);
    return;
  }

  const graph = await loadGraph(input);
  if (command === "overview") {
    process.stdout.write(json ? serializeGraph(graph.summary) : renderOverview(graph));
    return;
  }

  const query = queryParts.join(" ").trim();
  if (!query) throw new Error(`命令 ${command} 缺少查询内容`);
  if (command === "search") {
    const results = searchGraph(graph, query);
    process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : renderSearch(results, query));
    if (results.length === 0) process.exitCode = 3;
    return;
  }

  const handlers = {
    "trace-feature": traceFeature,
    "trace-url": traceUrl,
    "trace-statement": traceStatement,
    "trace-procedure": traceProcedure,
    "trace-table": traceTable,
  };
  const handler = handlers[command];
  if (!handler) throw new Error(`未知命令：${command}`);
  const trace = handler(graph, query);
  process.stdout.write(json ? `${JSON.stringify(trace, null, 2)}\n` : renderTraceMarkdown(trace, { title: `${command}: ${query}` }));
  if (trace.matches.length === 0) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`Legacy Code Atlas 错误：${error.message}\n`);
  process.exitCode = 2;
});
