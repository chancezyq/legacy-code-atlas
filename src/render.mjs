import { replaceUnsafeTextControls } from "./text-safety.mjs";

const MAX_TRACE_MARKDOWN_BYTES = 256 * 1024;
const MAX_INLINE_TEXT_CHARACTERS = 32 * 1024;
const MAX_RENDERED_MATCHES = 10;
const MAX_RENDERED_PATHS = 12;
const MAX_RENDERED_RELATIONS = 500;
const MAX_RENDERED_WARNINGS = 200;
const MAX_EVIDENCE_REFS = 20;
const MAX_LOOKUP_NODES = 10_000;
const MAX_LOOKUP_EDGES = 10_000;
const MAX_CHECKED_PATHS = 100;
const MAX_CHECKED_PATH_EDGES = 64;
const OUTPUT_TRUNCATED_NOTICE = "> 警告：output truncated；输出已截断（达到 256 KiB 安全上限或条目上限）。";

export function renderInlineText(value) {
  const escaped = replaceUnsafeTextControls(value)
    .replace(/([\\`\[\]<>])/gu, "\\$1");
  if (escaped.length <= MAX_INLINE_TEXT_CHARACTERS) return escaped;
  return `${escaped.slice(0, MAX_INLINE_TEXT_CHARACTERS - 3)}...`;
}

function createMarkdownWriter() {
  const chunks = [];
  const truncationSuffix = `\n${OUTPUT_TRUNCATED_NOTICE}\n`;
  const contentBudget = MAX_TRACE_MARKDOWN_BYTES - Buffer.byteLength(truncationSuffix);
  let contentBytes = 0;
  let truncated = false;
  let exhausted = false;

  return {
    get exhausted() {
      return exhausted;
    },
    markTruncated() {
      truncated = true;
    },
    line(value = "") {
      if (exhausted) return false;
      const chunk = `${value}\n`;
      const chunkBytes = Buffer.byteLength(chunk);
      if (contentBytes + chunkBytes > contentBudget) {
        truncated = true;
        exhausted = true;
        return false;
      }
      chunks.push(chunk);
      contentBytes += chunkBytes;
      return true;
    },
    lines(...values) {
      for (const value of values) {
        if (!this.line(value)) return false;
      }
      return true;
    },
    finish() {
      const content = chunks.join("");
      return truncated ? `${content}${truncationSuffix}` : content;
    },
  };
}

function cappedItems(value, limit, writer) {
  const items = Array.isArray(value) ? value : [];
  if (items.length > limit) writer.markTruncated();
  return items.slice(0, limit);
}

function evidenceRefs(edge, writer) {
  const evidence = Array.isArray(edge.evidence) ? edge.evidence : [];
  if (evidence.length > MAX_EVIDENCE_REFS) writer.markTruncated();
  const refs = [];
  const seen = new Set();
  const count = Math.min(evidence.length, MAX_EVIDENCE_REFS);
  for (let index = 0; index < count; index += 1) {
    const entry = evidence[index];
    const ref = `${renderInlineText(entry.file)}:${entry.line}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function nodeLabel(node) {
  return node ? `${renderInlineText(node.type)}:${renderInlineText(node.name)}` : "unknown";
}

function countMissingPathEdges(paths, edgeById, writer) {
  const checkedPaths = cappedItems(paths, MAX_CHECKED_PATHS, writer);
  let missing = 0;
  for (const path of checkedPaths) {
    const edgeIds = Array.isArray(path.edgeIds) ? path.edgeIds : [];
    if (edgeIds.length > MAX_CHECKED_PATH_EDGES) writer.markTruncated();
    const count = Math.min(edgeIds.length, MAX_CHECKED_PATH_EDGES);
    for (let index = 0; index < count; index += 1) {
      if (!edgeById.has(edgeIds[index])) missing += 1;
    }
  }
  return missing;
}

export function renderTraceMarkdown(trace, options = {}) {
  const writer = createMarkdownWriter();
  const title = options.title ?? `${trace.mode}: ${trace.query}`;
  writer.lines(`# ${renderInlineText(title)}`, "");

  const matches = cappedItems(trace.matches, MAX_RENDERED_MATCHES, writer);
  if (matches.length === 0) {
    writer.lines(`未找到与 \`${renderInlineText(trace.query)}\` 匹配的节点。`, "");
    const warnings = cappedItems(trace.warnings, MAX_RENDERED_WARNINGS, writer);
    for (const warning of warnings) {
      if (!writer.line(`- ${renderInlineText(warning)}`)) break;
    }
    return writer.finish();
  }

  const nodes = cappedItems(trace.nodes, MAX_LOOKUP_NODES, writer);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeLabels = new Map(nodes.map((node) => [node.id, nodeLabel(node)]));
  const lookupEdges = cappedItems(trace.edges, MAX_LOOKUP_EDGES, writer);
  const edgeById = new Map(lookupEdges.map((edge) => [edge.id, edge]));
  const labelForId = (id) => nodeLabels.get(id) ?? nodeLabel(nodeById.get(id));

  writer.lines("## 匹配入口", "");
  for (const match of matches) {
    if (!writer.line(`- ${nodeLabel(match)}（score ${match.score}）`)) break;
  }

  if (!writer.exhausted) writer.lines("", "## 主要链路", "");
  const paths = Array.isArray(trace.paths) ? trace.paths : [];
  const renderedPaths = cappedItems(paths, MAX_RENDERED_PATHS, writer);
  for (const currentPath of renderedPaths) {
    if (writer.exhausted) break;
    const pieces = [];
    const pathNodes = Array.isArray(currentPath.nodes) ? currentPath.nodes.slice(0, 64) : [];
    if ((currentPath.nodes?.length ?? 0) > pathNodes.length) writer.markTruncated();
    for (let index = 0; index < pathNodes.length; index += 1) {
      pieces.push(labelForId(pathNodes[index]));
      if (currentPath.edges?.[index]) pieces.push(`--${renderInlineText(currentPath.edges[index])}-->`);
    }
    if (!writer.line(`- ${pieces.join(" ")}`)) break;
  }

  const relations = cappedItems(trace.edges, MAX_RENDERED_RELATIONS, writer);
  const proven = relations.filter((edge) => edge.confidence >= 0.95);
  const heuristic = relations.filter((edge) => edge.confidence < 0.95);
  for (const [heading, edges] of [["确定关系", proven], ["启发式关系", heuristic]]) {
    if (writer.exhausted) break;
    if (!writer.lines("", `## ${heading}`, "")) break;
    if (edges.length === 0) {
      writer.line("- 无");
      continue;
    }
    for (const edge of edges) {
      const refs = evidenceRefs(edge, writer);
      const line = `- ${labelForId(edge.source)} --${renderInlineText(edge.type)}--> ${labelForId(edge.target)}`
        + `；置信度 ${edge.confidence.toFixed(2)}；${renderInlineText(edge.reason || "无说明")}`
        + (refs.length ? `；证据 ${refs.join(", ")}` : "");
      if (!writer.line(line)) break;
    }
  }

  if (!writer.exhausted) {
    const unusedEdgeIds = countMissingPathEdges(paths, edgeById, writer);
    if (unusedEdgeIds) writer.lines("", `> 警告：${unusedEdgeIds} 条路径边缺失。`);
  }
  if (!writer.exhausted && trace.warnings?.length) {
    writer.lines("", "## 未解析与扫描警告", "");
    const warnings = cappedItems(trace.warnings, MAX_RENDERED_WARNINGS, writer);
    for (const warning of warnings) {
      if (!writer.line(`- ${renderInlineText(warning)}`)) break;
    }
  }
  return writer.finish();
}
