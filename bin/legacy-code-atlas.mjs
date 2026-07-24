#!/usr/bin/env node

import { lstat, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { analyzeProjectDetailed } from "../src/analyzer.mjs";
import { writeFileAtomic } from "../src/atomic-write.mjs";
import { cacheEntriesFromResults, loadFileCache, saveFileCache } from "../src/cache.mjs";
import { serializeGraph } from "../src/graph.mjs";
import {
  MAX_GRAPH_INDEX_BYTES,
  parseAndValidateGraphIndex,
  validateGraphIndex,
} from "../src/index-validation.mjs";
import { searchGraph, traceFeature, traceProcedure, traceStatement, traceTable, traceUrl } from "../src/query.mjs";
import { buildDocumentModel, scopeSlug } from "../src/doc-model.mjs";
import { renderDiagrams, renderUiSpec, renderUseCases } from "../src/doc-render.mjs";
import { renderInlineText, renderTraceMarkdown } from "../src/render.mjs";
import { inspectOpenCodeCompatibility, renderOpenCodeDoctor } from "../src/opencode-doctor.mjs";
import { replaceUnsafeTextControls } from "../src/text-safety.mjs";

const HELP = `Legacy Code Atlas

Usage:
  legacy-code-atlas doctor <project> [--json]
  legacy-code-atlas analyze <project> [--output <index.json>] [--main-thread] [--json]
  legacy-code-atlas docs <project> [--json]
  legacy-code-atlas docs <project> --query-file <path> [--no-match-ok] [--json]
  legacy-code-atlas prepare-query <project>
  legacy-code-atlas overview <project-or-index> [--json]
  legacy-code-atlas search <project-or-index> <term> [--json]
  legacy-code-atlas trace-feature <project-or-index> <term> [--json]
  legacy-code-atlas trace-feature <project-or-standard-index> --query-file <path> [--no-match-ok] [--json]
  legacy-code-atlas trace-url <project-or-index> <url> [--json]
  legacy-code-atlas trace-url <project-or-standard-index> --query-file <path> [--no-match-ok] [--json]
  legacy-code-atlas trace-statement <project-or-index> <statement-id> [--json]
  legacy-code-atlas trace-statement <project-or-standard-index> --query-file <path> [--no-match-ok] [--json]
  legacy-code-atlas trace-procedure <project-or-index> <procedure> [--json]
  legacy-code-atlas trace-procedure <project-or-standard-index> --query-file <path> [--no-match-ok] [--json]
  legacy-code-atlas trace-table <project-or-index> <table> [--json]
  legacy-code-atlas trace-table <project-or-standard-index> --query-file <path> [--no-match-ok] [--json]

Query limits:
  At most 1024 characters and 64 tokens; query files must also be at most 64 KiB.
`;

const MAX_QUERY_FILE_BYTES = 64 * 1024;
const MAX_QUERY_CHARACTERS = 1024;
const MAX_QUERY_TOKENS = 64;
const MAX_DIAGNOSTIC_CHARACTERS = 4096;
const ATLAS_DIRECTORY_NAME = ".legacy-code-atlas";

const TRACE_HANDLERS = {
  "trace-feature": traceFeature,
  "trace-url": traceUrl,
  "trace-statement": traceStatement,
  "trace-procedure": traceProcedure,
  "trace-table": traceTable,
};

function parseArguments(argv) {
  const positional = [];
  let json = false;
  let output = "";
  let queryFile = null;
  let noMatchOk = false;
  let mainThread = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") json = true;
    else if (argv[index] === "--output") {
      output = argv[index + 1] ?? "";
      if (!output || output.startsWith("--")) throw new Error("--output 缺少输出路径");
      index += 1;
    } else if (argv[index] === "--query-file") {
      if (queryFile !== null) throw new Error("--query-file 不能重复使用");
      queryFile = argv[index + 1] ?? "";
      if (!queryFile || queryFile.startsWith("--")) throw new Error("--query-file 缺少文件路径");
      index += 1;
    } else if (argv[index] === "--no-match-ok") {
      if (noMatchOk) throw new Error("--no-match-ok 不能重复使用");
      noMatchOk = true;
    } else if (argv[index] === "--main-thread") {
      if (mainThread) throw new Error("--main-thread 不能重复使用");
      mainThread = true;
    } else positional.push(argv[index]);
  }
  return { positional, json, output, queryFile, noMatchOk, mainThread };
}

async function writeIndex(graph, outputPath) {
  validateGraphIndex(graph);
  const serialized = serializeGraph(graph);
  const bytes = Buffer.from(serialized);
  if (bytes.length > MAX_GRAPH_INDEX_BYTES) {
    throw new Error("项目索引不能超过 512 MiB");
  }
  await writeFileAtomic(outputPath, bytes);
  return serialized;
}

function safeDiagnosticMessage(error) {
  let message;
  try {
    message = replaceUnsafeTextControls(error?.message ?? error);
  } catch {
    message = "未知错误";
  }
  if (message.length <= MAX_DIAGNOSTIC_CHARACTERS) return message;
  return `${message.slice(0, MAX_DIAGNOSTIC_CHARACTERS - 3)}...`;
}

async function readGraphIndex(indexPath) {
  const handle = await open(indexPath, "r");
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("项目索引必须是普通文件");
    if (metadata.size > MAX_GRAPH_INDEX_BYTES) throw new Error("项目索引不能超过 512 MiB");

    const buffer = Buffer.allocUnsafe(metadata.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await handle.read(overflow, 0, 1, bytesRead);
    if (extra.bytesRead > 0) throw new Error("项目索引在读取期间发生变化，请重试");
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("项目索引必须是有效的 UTF-8");
  }
  return parseAndValidateGraphIndex(text);
}

async function loadProjectCache(cachePath) {
  let entry;
  try {
    entry = await lstat(cachePath);
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile() || hasMultipleLinks(entry)) {
    await rm(cachePath, { force: true });
    return new Map();
  }
  return loadFileCache(cachePath);
}

async function loadGraph(input) {
  const absolute = path.resolve(input);
  const metadata = await stat(absolute);
  if (metadata.isFile()) {
    if (isStandardIndexPath(absolute)) {
      const projectRoot = path.dirname(path.dirname(absolute));
      const indexPath = await inspectStandardIndex(projectRoot);
      return readGraphIndex(indexPath);
    }
    return readGraphIndex(absolute);
  }
  const existingIndexPath = await inspectStandardIndex(absolute, { allowMissing: true });
  if (existingIndexPath) return readGraphIndex(existingIndexPath);
  const indexPath = path.join(absolute, ATLAS_DIRECTORY_NAME, "index.json");
  const cachePath = path.join(absolute, ATLAS_DIRECTORY_NAME, "cache.json");
  const cached = await loadProjectCache(cachePath);
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

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePathName(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function hasMultipleLinks(entry) {
  return Number(entry.nlink) > 1;
}

function isStandardIndexPath(filePath) {
  return samePathName(path.basename(filePath), "index.json")
    && samePathName(path.basename(path.dirname(filePath)), ATLAS_DIRECTORY_NAME);
}

function validateLogicalQuery(query) {
  if (query.includes("\0")) throw new Error("问题内容不能包含 NUL");
  if (/[\u0001-\u001f\u007f-\u009f]/u.test(query)) throw new Error("问题内容不能包含控制字符");
  if (Array.from(query).length > MAX_QUERY_CHARACTERS) {
    throw new Error(`问题内容不能超过 ${MAX_QUERY_CHARACTERS} 个字符`);
  }
  if (query.split(/\s+/u).filter(Boolean).length > MAX_QUERY_TOKENS) {
    throw new Error(`问题内容不能超过 ${MAX_QUERY_TOKENS} 个词`);
  }
}

async function inspectAtlasDirectory(projectRoot, { allowMissing = false } = {}) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await realpath(absoluteProjectRoot);
  const atlasDirectory = path.join(absoluteProjectRoot, ATLAS_DIRECTORY_NAME);
  let entry;
  try {
    entry = await lstat(atlasDirectory);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return { atlasDirectory, canonicalProjectRoot, canonicalAtlasDirectory: null };
    }
    if (error?.code === "ENOENT") {
      throw new Error("项目缺少 .legacy-code-atlas 目录，请先运行 /atlas");
    }
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("项目的 .legacy-code-atlas 必须是真实目录，不能是符号链接或 junction");
  }

  const canonicalAtlasDirectory = await realpath(atlasDirectory);
  const expectedAtlasDirectory = path.join(canonicalProjectRoot, ATLAS_DIRECTORY_NAME);
  if (!samePathName(canonicalAtlasDirectory, expectedAtlasDirectory)) {
    throw new Error("项目的 .legacy-code-atlas 必须是真实目录，不能是符号链接或 junction");
  }
  return { atlasDirectory, canonicalProjectRoot, canonicalAtlasDirectory };
}

async function inspectStandardIndex(projectRoot, { allowMissing = false } = {}) {
  const { atlasDirectory } = await inspectAtlasDirectory(projectRoot, { allowMissing });
  const indexPath = path.join(atlasDirectory, "index.json");
  let entry;
  try {
    entry = await lstat(indexPath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") throw new Error("项目索引不存在，请先运行 /atlas");
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("项目索引必须是 .legacy-code-atlas/index.json 普通文件，不能是符号链接或 junction");
  }
  if (hasMultipleLinks(entry)) throw new Error("项目索引必须只有一个链接，不能使用硬链接");
  return indexPath;
}

async function prepareQueryFile(projectRoot) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const projectMetadata = await stat(absoluteProjectRoot);
  if (!projectMetadata.isDirectory()) throw new Error("prepare-query 需要项目目录");

  const indexPath = await inspectStandardIndex(absoluteProjectRoot);
  const atlasDirectory = path.dirname(indexPath);

  const queryPath = path.join(atlasDirectory, "query.txt");
  try {
    const queryEntry = await lstat(queryPath);
    if (queryEntry.isSymbolicLink() || !queryEntry.isFile() || hasMultipleLinks(queryEntry)) {
      await rm(queryPath, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFileAtomic(queryPath, "", { mode: 0o600 });
  return queryPath;
}

async function projectRootForQuery(input) {
  const absoluteInput = path.resolve(input);
  const inputMetadata = await stat(absoluteInput);
  if (inputMetadata.isDirectory()) return absoluteInput;
  const inputEntry = await lstat(absoluteInput);
  const atlasDirectory = path.dirname(absoluteInput);
  if (inputMetadata.isFile()
    && !inputEntry.isSymbolicLink()
    && !hasMultipleLinks(inputEntry)
    && samePathName(path.basename(absoluteInput), "index.json")
    && samePathName(path.basename(atlasDirectory), ".legacy-code-atlas")) {
    const projectRoot = path.dirname(atlasDirectory);
    await inspectStandardIndex(projectRoot);
    return projectRoot;
  }
  throw new Error("使用 --query-file 时，索引路径必须是 <project>/.legacy-code-atlas/index.json");
}

async function readQueryFile(queryFile, projectRoot) {
  const indexPath = await inspectStandardIndex(projectRoot);
  const atlasDirectory = path.dirname(indexPath);
  const canonicalAtlasDirectory = await realpath(atlasDirectory);

  const absoluteQueryFile = path.resolve(projectRoot, queryFile);
  const queryEntry = await lstat(absoluteQueryFile);
  if (!queryEntry.isFile() || queryEntry.isSymbolicLink()) {
    throw new Error("问题文件必须是普通文件，不能是符号链接或 junction");
  }
  if (hasMultipleLinks(queryEntry)) throw new Error("问题文件必须只有一个链接，不能使用硬链接");
  const canonicalQueryFile = await realpath(absoluteQueryFile);
  if (!isSameOrDescendant(canonicalAtlasDirectory, canonicalQueryFile)) {
    throw new Error("问题文件必须位于项目的 .legacy-code-atlas 目录内");
  }

  const pathMetadata = await stat(canonicalQueryFile);
  if (!pathMetadata.isFile()) throw new Error("问题文件必须是普通文件");

  const handle = await open(canonicalQueryFile, "r");
  let queryBytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("问题文件必须是普通文件");
    if (metadata.size > MAX_QUERY_FILE_BYTES) throw new Error("问题文件不能超过 64 KiB");

    const buffer = Buffer.alloc(MAX_QUERY_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_QUERY_FILE_BYTES) throw new Error("问题文件不能超过 64 KiB");
    queryBytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  let query;
  try {
    query = new TextDecoder("utf-8", { fatal: true }).decode(queryBytes);
  } catch {
    throw new Error("问题文件必须是有效的 UTF-8");
  }
  if (query.includes("\0")) throw new Error("问题文件不能包含 NUL");
  query = query.trim();
  if (!query) throw new Error("问题文件不能为空");
  return query;
}

function renderOverview(graph) {
  const lines = [
    "# 项目概览",
    "",
    `- 根目录：${renderInlineText(graph.project.root)}`,
    `- 节点：${graph.summary.nodes}`,
    `- 关系：${graph.summary.edges}`,
    "",
    "## 节点类型",
    "",
    ...Object.entries(graph.summary.nodeTypes).map(([type, count]) => `- ${renderInlineText(type)}: ${count}`),
    "",
    "## 关系类型",
    "",
    ...Object.entries(graph.summary.edgeTypes).map(([type, count]) => `- ${renderInlineText(type)}: ${count}`),
  ];
  return `${lines.join("\n")}\n`;
}

function renderSearch(results, query) {
  const lines = [`# 搜索：${renderInlineText(query)}`, ""];
  if (results.length === 0) lines.push("未找到匹配节点。");
  else for (const result of results) {
    const evidence = result.evidence?.[0];
    lines.push(`- ${renderInlineText(result.id)}（score ${result.score}）${evidence ? `；${renderInlineText(evidence.file)}:${evidence.line}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { positional, json, output, queryFile, noMatchOk, mainThread } = parseArguments(process.argv.slice(2));
  const [command, input, ...queryParts] = positional;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!input) throw new Error(`命令 ${command} 缺少项目或索引路径`);

  const positionalQuery = queryParts.join(" ").trim();
  if (queryFile !== null && queryParts.length > 0) {
    throw new Error("不能同时使用查询参数和 --query-file");
  }
  if (queryFile !== null && !TRACE_HANDLERS[command] && command !== "docs") {
    throw new Error(`命令 ${command} 不支持 --query-file`);
  }
  if (noMatchOk && !TRACE_HANDLERS[command] && command !== "docs") {
    throw new Error(`命令 ${command} 不支持 --no-match-ok`);
  }
  if (noMatchOk && queryFile === null) {
    throw new Error("--no-match-ok 只能与 --query-file 一起使用");
  }
  if (mainThread && command !== "analyze") {
    throw new Error(`命令 ${command} 不支持 --main-thread`);
  }

  if (command === "doctor") {
    if (queryParts.length > 0 || output || queryFile !== null || noMatchOk) {
      throw new Error("doctor 不接受额外参数");
    }
    const report = await inspectOpenCodeCompatibility(input);
    process.stdout.write(json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderOpenCodeDoctor(report));
    if (!report.ok) process.exitCode = 4;
    return;
  }

  if (command === "prepare-query") {
    if (queryParts.length > 0 || json || output) throw new Error("prepare-query 不接受额外参数");
    const queryPath = await prepareQueryFile(input);
    process.stdout.write(`问题文件已安全准备：${queryPath}\n`);
    return;
  }

  if (command === "analyze") {
    const project = path.resolve(input);
    await inspectStandardIndex(project, { allowMissing: true });
    const outputPath = path.resolve(output || path.join(project, ATLAS_DIRECTORY_NAME, "index.json"));
    const cachePath = path.join(project, ATLAS_DIRECTORY_NAME, "cache.json");
    const cached = await loadProjectCache(cachePath);
    const detailed = await analyzeProjectDetailed(project, {
      ...(mainThread ? { mainThread: true } : {}),
      cached,
      cacheWriter: (results, { signal }) => saveFileCache(
        cachePath,
        cacheEntriesFromResults(results),
        { signal },
      ),
    });
    const graph = detailed.graph;
    const serialized = await writeIndex(graph, outputPath);
    if (json) process.stdout.write(serialized);
    else process.stdout.write(`分析完成：${graph.summary.nodes} 个节点，${graph.summary.edges} 条关系\n索引：${outputPath}\n`);
    return;
  }

  if (command === "docs") {
    if (queryParts.length > 0 || output) throw new Error("docs 不接受额外参数");
    const project = path.resolve(input);
    const projectMetadata = await stat(project);
    if (!projectMetadata.isDirectory()) throw new Error("docs 需要项目目录");
    let scopeQuery;
    if (queryFile !== null) {
      scopeQuery = await readQueryFile(queryFile, project);
      validateLogicalQuery(scopeQuery);
    }
    const graph = await loadGraph(project);
    const model = buildDocumentModel(graph, scopeQuery === undefined ? {} : { scopeQuery });
    const docsDir = scopeQuery === undefined
      ? path.join(project, ATLAS_DIRECTORY_NAME, "docs")
      : path.join(project, ATLAS_DIRECTORY_NAME, "docs", "scoped", scopeSlug(scopeQuery));
    const documents = [
      ["use-cases.md", renderUseCases(model)],
      ["ui-spec.md", renderUiSpec(model)],
      ["diagrams.md", renderDiagrams(model)],
    ];
    const files = [];
    for (const [fileName, content] of documents) {
      const target = path.join(docsDir, fileName);
      await writeFileAtomic(target, content);
      files.push(path.relative(project, target).replaceAll("\\", "/"));
    }
    const scope = model.scope
      ? { kind: model.scope.kind, query: model.scope.query, matched: model.scope.matched }
      : null;
    if (json) {
      process.stdout.write(`${JSON.stringify({ files, scope, stats: model.stats, truncated: model.truncated }, null, 2)}\n`);
    } else {
      const scopeSummary = scope
        ? [`范围：${scope.kind === "module" ? "模块" : "功能"} ${scope.query}${scope.matched ? "" : "（no match，未找到匹配，文档为空）"}`]
        : [];
      process.stdout.write([
        `文档生成完成：${model.stats.useCases} 个用例，${model.stats.pages} 个页面，${model.stats.modules} 个模块`,
        ...scopeSummary,
        ...files.map((file) => `- ${file}`),
        "",
      ].join("\n"));
    }
    if (scope && !scope.matched && !noMatchOk) process.exitCode = 3;
    return;
  }

  const query = queryFile === null
    ? positionalQuery
    : await readQueryFile(queryFile, await projectRootForQuery(input));
  if (command !== "overview") {
    if (!query) throw new Error(`命令 ${command} 缺少查询内容`);
    validateLogicalQuery(query);
  }
  const graph = await loadGraph(input);
  if (command === "overview") {
    process.stdout.write(json ? serializeGraph(graph.summary) : renderOverview(graph));
    return;
  }

  if (command === "search") {
    const results = searchGraph(graph, query);
    process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : renderSearch(results, query));
    if (results.length === 0) process.exitCode = 3;
    return;
  }

  const handler = TRACE_HANDLERS[command];
  if (!handler) throw new Error(`未知命令：${command}`);
  const trace = handler(graph, query);
  process.stdout.write(json ? `${JSON.stringify(trace, null, 2)}\n` : renderTraceMarkdown(trace, { title: `${command}: ${query}` }));
  if (trace.matches.length === 0 && !noMatchOk) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`Legacy Code Atlas 错误：${safeDiagnosticMessage(error)}\n`);
  process.exitCode = 2;
});
