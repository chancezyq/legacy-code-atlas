import path from "node:path";

import { containsUnsafeTextControl } from "./text-safety.mjs";

export const MAX_GRAPH_INDEX_BYTES = 512 * 1024 * 1024;
export const MAX_EVIDENCE_SNIPPET_CHARACTERS = 64 * 1024;

const GRAPH_SCHEMA_VERSION = "1.0.0";
const MAX_INDEX_STRING_CHARACTERS = 1024 * 1024;
const MAX_PROJECT_ROOT_CHARACTERS = 32 * 1024;
const MAX_PATH_CHARACTERS = 32 * 1024;
const MAX_PATH_SEGMENT_CHARACTERS = 255;
const MAX_IDENTIFIER_CHARACTERS = 64 * 1024;
const MAX_EDGE_IDENTIFIER_CHARACTERS = 192 * 1024;
const MAX_RENDERED_FIELD_CHARACTERS = 16 * 1024;
export const MAX_SEARCH_TEXT_CHARACTERS = 256 * 1024;
const WINDOWS_INVALID_PATH_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/iu;
const ROOT_KEYS = new Set(["schemaVersion", "project", "summary", "nodes", "edges", "warnings"]);
const PROJECT_KEYS = new Set(["root"]);
const SUMMARY_KEYS = new Set(["nodes", "edges", "nodeTypes", "edgeTypes"]);
const NODE_KEYS = new Set(["id", "type", "name", "filePath", "evidence", "data", "searchText"]);
const EDGE_KEYS = new Set(["id", "source", "target", "type", "confidence", "reason", "evidence", "data"]);
const EVIDENCE_KEYS = new Set(["file", "line", "column", "snippet"]);
const NODE_TYPES = new Set([
  "file",
  "page",
  "route",
  "java_type",
  "java_method",
  "spring_bean",
  "statement",
  "procedure",
  "tiles_definition",
  "table",
]);
const EDGE_TYPES = new Set([
  "contains",
  "submits_to",
  "links_to",
  "requests",
  "includes",
  "loads_script",
  "maps_to",
  "dispatches_to",
  "forwards_to",
  "redirects_to",
  "uses_tile",
  "declares",
  "implements",
  "implemented_by",
  "calls",
  "calls_procedure",
  "uses_statement",
  "reads_from",
  "writes_to",
  "extends",
  "extends_tile",
  "uses_template",
  "puts",
]);

function fail(message) {
  throw new Error(`项目索引无效：${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  return value;
}

function requireSafeString(value, label, {
  nonEmpty = false,
  maxCharacters = MAX_INDEX_STRING_CHARACTERS,
} = {}) {
  if (typeof value !== "string") fail(`${label} 必须是字符串`);
  if (nonEmpty && value.length === 0) fail(`${label} 不能为空`);
  if (value.length > maxCharacters) fail(`${label} 过长`);
  if (containsUnsafeTextControl(value)) fail(`${label} 不能包含控制字符`);
  return value;
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} 必须是非负整数`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} 必须是正整数`);
  return value;
}

function requireOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} 包含未知字段`);
  }
}

function requireProjectRelativePath(value, label) {
  requireSafeString(value, label, { nonEmpty: true, maxCharacters: MAX_PATH_CHARACTERS });
  const segments = value.split("/");
  if (value.includes("\\")
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
    || /^file:/iu.test(value)
    || path.posix.normalize(value) !== value
    || segments.some((part) => part === "" || part === "." || part === "..")
    || segments.some((part) => {
      const basename = part.split(".", 1)[0].replace(/[ .]+$/u, "").normalize("NFKC");
      return part.length > MAX_PATH_SEGMENT_CHARACTERS
        || WINDOWS_INVALID_PATH_CHARACTERS.test(part)
        || /[ .]$/u.test(part)
        || WINDOWS_RESERVED_BASENAME.test(basename);
    })) {
    fail(`${label} 必须是规范的项目相对 POSIX 路径`);
  }
  return value;
}

function validateEvidenceList(value, label) {
  const evidence = requireArray(value, label);
  for (let index = 0; index < evidence.length; index += 1) {
    const itemLabel = `${label}[${index}]`;
    const item = requirePlainObject(evidence[index], itemLabel);
    requireOnlyKeys(item, EVIDENCE_KEYS, itemLabel);
    requireProjectRelativePath(item.file, `${itemLabel}.file 引用路径`);
    requirePositiveInteger(item.line, `${itemLabel}.line`);
    requirePositiveInteger(item.column, `${itemLabel}.column`);
    requireSafeString(item.snippet, `${itemLabel}.snippet`, {
      maxCharacters: MAX_EVIDENCE_SNIPPET_CHARACTERS,
    });
  }
}

function countTypes(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return counts;
}

function validateCountMap(value, expected, label) {
  const countMap = requirePlainObject(value, label);
  if (Object.keys(countMap).length !== expected.size) fail(`${label} 与索引内容不一致`);
  for (const [type, count] of expected) {
    requireNonnegativeInteger(countMap[type], `${label}.${type}`);
    if (countMap[type] !== count) fail(`${label}.${type} 与索引内容不一致`);
  }
}

export function validateGraphIndex(graph) {
  requirePlainObject(graph, "根对象");
  requireOnlyKeys(graph, ROOT_KEYS, "根对象");
  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    fail(`schemaVersion 必须是 ${GRAPH_SCHEMA_VERSION}`);
  }

  const project = requirePlainObject(graph.project, "project");
  requireOnlyKeys(project, PROJECT_KEYS, "project");
  requireSafeString(project.root, "project.root", {
    nonEmpty: true,
    maxCharacters: MAX_PROJECT_ROOT_CHARACTERS,
  });

  const nodes = requireArray(graph.nodes, "nodes");
  const edges = requireArray(graph.edges, "edges");
  const warnings = requireArray(graph.warnings, "warnings");
  const nodeIds = new Set();
  const edgeIds = new Set();

  for (let index = 0; index < nodes.length; index += 1) {
    const label = `nodes[${index}]`;
    const node = requirePlainObject(nodes[index], label);
    requireOnlyKeys(node, NODE_KEYS, label);
    requireSafeString(node.id, `${label}.id`, {
      nonEmpty: true,
      maxCharacters: MAX_IDENTIFIER_CHARACTERS,
    });
    requireSafeString(node.type, `${label}.type`, { nonEmpty: true });
    if (!NODE_TYPES.has(node.type)) fail(`${label}.type 未知：${node.type}`);
    requireSafeString(node.name, `${label}.name`, {
      maxCharacters: MAX_RENDERED_FIELD_CHARACTERS,
    });
    if (node.filePath !== undefined) requireProjectRelativePath(node.filePath, `${label}.filePath 路径`);
    validateEvidenceList(node.evidence, `${label}.evidence`);
    requirePlainObject(node.data, `${label}.data`);
    const searchText = requireArray(node.searchText, `${label}.searchText`);
    const uniqueSearchText = new Set();
    for (let textIndex = 0; textIndex < searchText.length; textIndex += 1) {
      const text = requireSafeString(searchText[textIndex], `${label}.searchText[${textIndex}]`, {
        maxCharacters: MAX_SEARCH_TEXT_CHARACTERS,
      });
      if (uniqueSearchText.has(text)) fail(`${label}.searchText 必须唯一`);
      uniqueSearchText.add(text);
    }
    if (nodeIds.has(node.id)) fail(`节点 ID 必须唯一，发现重复：${node.id}`);
    nodeIds.add(node.id);
  }

  for (let index = 0; index < edges.length; index += 1) {
    const label = `edges[${index}]`;
    const edge = requirePlainObject(edges[index], label);
    requireOnlyKeys(edge, EDGE_KEYS, label);
    requireSafeString(edge.id, `${label}.id`, {
      nonEmpty: true,
      maxCharacters: MAX_EDGE_IDENTIFIER_CHARACTERS,
    });
    requireSafeString(edge.source, `${label}.source`, {
      nonEmpty: true,
      maxCharacters: MAX_IDENTIFIER_CHARACTERS,
    });
    requireSafeString(edge.target, `${label}.target`, {
      nonEmpty: true,
      maxCharacters: MAX_IDENTIFIER_CHARACTERS,
    });
    requireSafeString(edge.type, `${label}.type`, { nonEmpty: true });
    if (!EDGE_TYPES.has(edge.type)) fail(`${label}.type 未知：${edge.type}`);
    if (typeof edge.confidence !== "number" || !Number.isFinite(edge.confidence)
      || edge.confidence < 0 || edge.confidence > 1) {
      fail(`${label}.confidence 必须在 0 到 1 之间`);
    }
    requireSafeString(edge.reason, `${label}.reason`, {
      maxCharacters: MAX_RENDERED_FIELD_CHARACTERS,
    });
    validateEvidenceList(edge.evidence, `${label}.evidence`);
    requirePlainObject(edge.data, `${label}.data`);
    if (edgeIds.has(edge.id)) fail(`边 ID 必须唯一，发现重复：${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      fail(`边端点引用不存在的节点：${edge.id}`);
    }
  }

  for (let index = 0; index < warnings.length; index += 1) {
    requireSafeString(warnings[index], `warnings[${index}]`, {
      maxCharacters: MAX_RENDERED_FIELD_CHARACTERS,
    });
  }

  const summary = requirePlainObject(graph.summary, "summary");
  requireOnlyKeys(summary, SUMMARY_KEYS, "summary");
  requireNonnegativeInteger(summary.nodes, "summary.nodes");
  requireNonnegativeInteger(summary.edges, "summary.edges");
  if (summary.nodes !== nodes.length || summary.edges !== edges.length) fail("summary 数量与索引内容不一致");
  validateCountMap(summary.nodeTypes, countTypes(nodes), "summary.nodeTypes");
  validateCountMap(summary.edgeTypes, countTypes(edges), "summary.edgeTypes");
  return graph;
}

export function parseAndValidateGraphIndex(text) {
  let graph;
  try {
    graph = JSON.parse(text);
  } catch {
    throw new Error("项目索引不是有效的 JSON");
  }
  return validateGraphIndex(graph);
}
