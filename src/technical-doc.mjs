import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { searchGraph, traverseGraph } from "./query.mjs";
import { renderInlineText } from "./render.mjs";

const MAX_MATCHES_PER_TYPE = 8;
const MAX_STARTS = 64;
const MAX_NODES = 1_000;
const MAX_RELATIONS = 2_000;
const MAX_FIELDS = 1_000;
const MAX_PROPERTIES = 1_000;
const MAX_WARNINGS = 200;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_TECHNICAL_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_CITATION_SOURCE_BYTES = 5 * 1024 * 1024;
const REQUIRED_TECHNICAL_HEADINGS = [
  "## 1. Overview",
  "## 2. Workflow Stages",
  "## 3. Database Tables",
  "## 4. Class Architecture",
  "## 5. Data Flow",
  "## 6. Business Rules",
  "## 7. Error Messages and Lookups",
  "## 8. Evidence Gaps",
];
const TECHNICAL_EDGE_TYPES = [
  "submits_to", "links_to", "requests", "includes", "loads_script",
  "maps_to", "dispatches_to", "forwards_to", "redirects_to", "uses_tile",
  "declares", "implements", "implemented_by", "calls", "calls_procedure",
  "uses_statement", "reads_from", "writes_to", "extends", "extends_tile",
  "uses_template", "puts",
];
const SEARCHABLE_TYPES = [
  "page", "route", "java_type", "java_method", "spring_bean",
  "statement", "procedure", "tiles_definition", "table",
];
const TECHNICAL_MANIFEST_SCHEMA_VERSION = "1.0.0";

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function firstEvidence(value) {
  const candidate = Array.isArray(value?.evidence) ? value.evidence[0] : value?.evidence ?? value;
  if (!candidate || typeof candidate.file !== "string" || !Number.isInteger(candidate.line)) return null;
  return {
    file: candidate.file,
    line: candidate.line,
    column: Number.isInteger(candidate.column) ? candidate.column : 1,
  };
}

function evidenceList(value) {
  const candidates = Array.isArray(value?.evidence) ? value.evidence : [];
  const seen = new Set();
  const results = [];
  for (const candidate of candidates) {
    const normalized = firstEvidence(candidate);
    if (!normalized) continue;
    const key = `${normalized.file}\0${normalized.line}\0${normalized.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(normalized);
  }
  return results;
}

function unionTraversal(graph, startIds) {
  const options = {
    maxDepth: 20,
    maxPaths: 200,
    maxStates: 10_000,
    allowedEdgeTypes: TECHNICAL_EDGE_TYPES,
  };
  const incoming = traverseGraph(graph, startIds, { ...options, direction: "incoming" });
  const outgoing = traverseGraph(graph, startIds, { ...options, direction: "outgoing" });
  const nodeIds = new Set([...startIds, ...incoming.nodes.map(({ id }) => id), ...outgoing.nodes.map(({ id }) => id)]);
  const edgeIds = new Set([...incoming.edges.map(({ id }) => id), ...outgoing.edges.map(({ id }) => id)]);
  return {
    nodeIds,
    edgeIds,
    truncated: incoming.truncated || outgoing.truncated,
    limits: {
      incoming: {
        state: incoming.stateLimitReached,
        path: incoming.pathLimitReached,
        depth: incoming.depthLimitReached,
      },
      outgoing: {
        state: outgoing.stateLimitReached,
        path: outgoing.pathLimitReached,
        depth: outgoing.depthLimitReached,
      },
    },
  };
}

function compactNode(node) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    ...(node.filePath ? { filePath: node.filePath } : {}),
    evidence: evidenceList(node),
    data: node.data ?? {},
  };
}

export function buildTechnicalEvidence(graph, query) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError("technical evidence requires a validated graph index");
  }
  if (typeof query !== "string" || !query.trim()) throw new TypeError("technical evidence query is required");
  const normalizedQuery = query.trim();
  let candidateMatchesTruncated = false;
  const matches = SEARCHABLE_TYPES.flatMap((type) => {
    const typeMatches = searchGraph(
      graph,
      normalizedQuery,
      { types: [type], limit: MAX_MATCHES_PER_TYPE + 1 },
    );
    if (typeMatches.length > MAX_MATCHES_PER_TYPE) candidateMatchesTruncated = true;
    return typeMatches.slice(0, MAX_MATCHES_PER_TYPE);
  }).sort((left, right) => right.score - left.score || compareText(left.id, right.id));
  if (matches.length === 0) {
    return {
      query: normalizedQuery,
      matched: false,
      matches: [],
      nodes: [],
      relations: [],
      outcomes: [],
      fields: [],
      properties: [],
      sourceFiles: [],
      warnings: [`No graph facts matched ${normalizedQuery}`, ...(graph.warnings ?? []).slice(0, MAX_WARNINGS)],
      truncated: false,
      limits: null,
    };
  }
  if (matches.length > MAX_STARTS) candidateMatchesTruncated = true;
  const starts = matches.slice(0, MAX_STARTS);
  const traversal = unionTraversal(graph, starts.map(({ id }) => id));

  const retainedRouteIds = new Set(graph.nodes
    .filter((node) => traversal.nodeIds.has(node.id) && node.type === "route")
    .map(({ id }) => id));
  for (const edge of graph.edges) {
    if (!retainedRouteIds.has(edge.source) || !["forwards_to", "redirects_to"].includes(edge.type)) continue;
    traversal.edgeIds.add(edge.id);
    traversal.nodeIds.add(edge.target);
  }

  const propertyMatches = searchGraph(graph, normalizedQuery, { types: ["file"], limit: MAX_PROPERTIES })
    .filter((node) => Array.isArray(node.data?.properties));
  for (const node of propertyMatches) traversal.nodeIds.add(node.id);

  const selectedNodes = graph.nodes
    .filter(({ id }) => traversal.nodeIds.has(id))
    .slice(0, MAX_NODES)
    .map(compactNode);
  const retainedNodeIds = new Set(selectedNodes.map(({ id }) => id));
  const relations = graph.edges
    .filter((edge) => traversal.edgeIds.has(edge.id)
      && retainedNodeIds.has(edge.source)
      && retainedNodeIds.has(edge.target))
    .slice(0, MAX_RELATIONS)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      confidence: edge.confidence,
      reason: edge.reason,
      evidence: evidenceList(edge),
      data: edge.data ?? {},
    }));
  const fields = selectedNodes
    .filter(({ type }) => type === "page")
    .flatMap((page) => (Array.isArray(page.data?.fieldDetails) ? page.data.fieldDetails : []).map((field) => ({
      page: page.filePath ?? page.name,
      ...field,
    })))
    .slice(0, MAX_FIELDS);
  const properties = selectedNodes
    .filter(({ type }) => type === "file")
    .flatMap((file) => (Array.isArray(file.data?.properties) ? file.data.properties : []).map((entry) => ({
      file: file.filePath ?? file.name,
      ...entry,
    })))
    .filter((entry) => `${entry.key}\n${entry.value}`.toLowerCase().includes(normalizedQuery.toLowerCase()))
    .slice(0, MAX_PROPERTIES);
  const outcomes = relations
    .filter((relation) => ["forwards_to", "redirects_to"].includes(relation.type))
    .map((relation) => ({
      route: relation.source,
      target: relation.target,
      relation: relation.type,
      framework: relation.data?.outcome?.framework ?? "unknown",
      name: relation.data?.outcome?.name ?? "unknown",
      classification: relation.data?.outcome?.classification ?? "configured-candidate",
      configEvidence: relation.evidence,
      codeEvidence: evidenceList({ evidence: relation.data?.outcome?.codeEvidence ?? [] }),
    }));
  const sourceFiles = [...new Set(selectedNodes.flatMap((node) => [
    node.filePath,
    ...node.evidence.map(({ file }) => file),
  ]).concat(
    relations.flatMap((relation) => relation.evidence.map(({ file }) => file)),
    outcomes.flatMap((outcome) => outcome.codeEvidence.map(({ file }) => file)),
  ).filter(Boolean))].sort(compareText);

  return {
    query: normalizedQuery,
    matched: true,
    matches: starts.map(compactNode),
    nodes: selectedNodes,
    relations,
    outcomes,
    fields,
    properties,
    sourceFiles,
    warnings: [
      ...(candidateMatchesTruncated ? ["Feature search candidates were truncated; omitted entry points need verification."] : []),
      ...(graph.warnings ?? []),
    ].slice(0, MAX_WARNINGS),
    truncated: candidateMatchesTruncated
      || traversal.truncated
      || selectedNodes.length >= MAX_NODES
      || relations.length >= MAX_RELATIONS
      || fields.length >= MAX_FIELDS
      || properties.length >= MAX_PROPERTIES,
    limits: traversal.limits,
  };
}

function ref(value) {
  const evidence = firstEvidence(value);
  return evidence ? `${renderInlineText(evidence.file)}:${evidence.line}` : "no direct citation";
}

function tableCell(value) {
  return renderInlineText(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function boundedMarkdown(lines) {
  const suffix = "\n> Evidence dossier truncated at the safety limit. Treat omitted areas as Needs verification.\n";
  const budget = MAX_EVIDENCE_BYTES - Buffer.byteLength(suffix);
  const retained = [];
  let bytes = 0;
  for (const line of lines) {
    const chunk = `${line}\n`;
    const chunkBytes = Buffer.byteLength(chunk);
    if (bytes + chunkBytes > budget) return `${retained.join("\n")}\n${suffix}`;
    retained.push(line);
    bytes += chunkBytes;
  }
  return `${retained.join("\n")}\n`;
}

export function renderTechnicalEvidence(evidence) {
  const lines = [
    `# Technical Workflow Evidence: ${renderInlineText(evidence.query)}`,
    "",
    "> This file contains extracted facts, not a finished specification. Source paths are project-relative.",
    "",
    "## Matched Scope",
    "",
  ];
  if (!evidence.matched) lines.push("- No matching graph facts were found.");
  for (const match of evidence.matches) lines.push(`- ${match.type} \`${renderInlineText(match.name)}\` (${ref(match)})`);
  lines.push("", "## Source Files", "");
  for (const file of evidence.sourceFiles) lines.push(`- \`${renderInlineText(file)}\``);

  lines.push("", "## UI Fields", "", "| Page | Field | Element / type | Static value | Flags | Evidence |", "| --- | --- | --- | --- | --- | --- |");
  for (const field of evidence.fields) {
    const flags = [
      field.required ? "required-in-markup" : "",
      field.runtimeDerived ? "runtime-derived" : "",
      field.choice ? "choice" : "",
      field.disabled ? "disabled" : "",
      field.submittable === false ? "not-submittable" : "",
    ].filter(Boolean).join(", ");
    lines.push(`| ${tableCell(field.page)} | \`${tableCell(field.name)}\` | ${tableCell(`${field.element} / ${field.inputType}`)} | ${tableCell(field.staticValue)} | ${tableCell(flags)} | ${ref(field.evidence)} |`);
  }
  if (evidence.fields.length === 0) lines.push("| - | - | - | - | - | No retained UI field facts | ");

  const nodeById = new Map(evidence.nodes.map((node) => [node.id, node]));
  lines.push("", "## Source Relationships", "", "| Source | Relation | Target | Confidence | Reason | Evidence |", "| --- | --- | --- | ---: | --- | --- |");
  for (const relation of evidence.relations) {
    lines.push(`| ${tableCell(nodeById.get(relation.source)?.name ?? relation.source)} | ${tableCell(relation.type)} | ${tableCell(nodeById.get(relation.target)?.name ?? relation.target)} | ${relation.confidence.toFixed(2)} | ${tableCell(relation.reason)} | ${ref(relation)} |`);
  }

  lines.push("", "## Configured Outcomes", "", "| Route | Outcome | Target | Classification | Configuration evidence | Code evidence |", "| --- | --- | --- | --- | --- | --- |");
  for (const outcome of evidence.outcomes) {
    const codeEvidence = outcome.codeEvidence.length > 0
      ? outcome.codeEvidence.map((entry) => ref(entry)).join(", ")
      : "none retained";
    lines.push(`| ${tableCell(nodeById.get(outcome.route)?.name ?? outcome.route)} | ${tableCell(outcome.name)} | ${tableCell(nodeById.get(outcome.target)?.name ?? outcome.target)} | ${tableCell(outcome.classification)} | ${ref(outcome.configEvidence[0])} | ${tableCell(codeEvidence)} |`);
  }
  if (evidence.outcomes.length === 0) lines.push("| - | - | - | - | No retained configured outcomes | - |");

  lines.push("", "## Java and Configuration Components", "");
  for (const node of evidence.nodes.filter(({ type }) => ["route", "java_type", "java_method", "spring_bean", "tiles_definition"].includes(type))) {
    lines.push(`- ${node.type} \`${renderInlineText(node.name)}\` (${ref(node)})`);
  }

  lines.push("", "## SQL Statements and Tables", "");
  for (const node of evidence.nodes.filter(({ type }) => ["statement", "procedure", "table"].includes(type))) {
    const detail = node.type === "statement"
      ? `; operation=${renderInlineText(node.data?.type ?? "unknown")}; SQL=${renderInlineText(node.data?.sql ?? "")}`
      : "";
    lines.push(`- ${node.type} \`${renderInlineText(node.name)}\`${detail} (${ref(node)})`);
  }

  lines.push("", "## Relevant Messages and Lookups", "");
  for (const entry of evidence.properties) {
    lines.push(`- \`${renderInlineText(entry.key)}\` = ${renderInlineText(entry.value)} (${ref(entry.evidence)})`);
  }
  if (evidence.properties.length === 0) lines.push("- No matching parsed properties entries were retained.");

  lines.push("", "## Uncertainty and Warnings", "");
  if (evidence.truncated) lines.push("- Evidence traversal or rendering was truncated; omitted conclusions require verification.");
  for (const warning of evidence.warnings) lines.push(`- ${renderInlineText(warning)}`);
  if (!evidence.truncated && evidence.warnings.length === 0) lines.push("- No parser warning was reported for the retained evidence.");
  return boundedMarkdown(lines);
}

export function renderTechnicalInstructions(evidence) {
  return `# Model Writing Contract: ${renderInlineText(evidence.query)}

Write the final file named \`Technical_Workflow_Design.md\` in the same directory as this contract.
Use the evidence dossier and inspect only its project-relative source files. Never execute project code, JSP, SQL, or procedures.

Every concrete claim must include a project-relative \`path:line\` citation. Keep exact source identifiers unchanged.
Label a cross-file conclusion as **Derived** and cite every supporting location. Label ambiguity or missing evidence as **Needs verification**. Do not infer facts from naming conventions alone.

The final document must contain these headings exactly:

## 1. Overview
## 2. Workflow Stages
## 3. Database Tables
## 4. Class Architecture
## 5. Data Flow
## 6. Business Rules
## 7. Error Messages and Lookups
## 8. Evidence Gaps

For UI fields, distinguish markup-required, runtime-derived, and unknown validation requirements. For Struts outcomes, distinguish configured candidates from code-returned possibilities. For database content, do not invent columns or types that are absent from source evidence. Retain an empty required section with a Needs verification explanation instead of omitting it.
`;
}

export function renderTechnicalEvidenceManifest(evidence, renderedEvidence) {
  if (typeof renderedEvidence !== "string") throw new TypeError("rendered technical evidence is required");
  return `${JSON.stringify({
    schemaVersion: TECHNICAL_MANIFEST_SCHEMA_VERSION,
    query: evidence.query,
    evidenceSha256: createHash("sha256").update(renderedEvidence).digest("hex"),
    sourceFiles: evidence.sourceFiles,
  }, null, 2)}\n`;
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readTechnicalDocument(documentPath) {
  const entry = await lstat(documentPath);
  if (entry.isSymbolicLink()) throw new Error("technical document must not be a symbolic link");
  if (!entry.isFile()) throw new Error("technical document must be a regular file");
  if (Number(entry.nlink) > 1) throw new Error("technical document must not be a hard link");
  if (entry.size > MAX_TECHNICAL_DOCUMENT_BYTES) {
    throw new Error("technical document must not exceed 2 MiB");
  }

  const handle = await open(documentPath, "r");
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("technical document must be a regular file");
    if (Number(metadata.nlink) > 1) throw new Error("technical document must not be a hard link");
    if (metadata.size > MAX_TECHNICAL_DOCUMENT_BYTES) {
      throw new Error("technical document must not exceed 2 MiB");
    }
    const buffer = Buffer.alloc(MAX_TECHNICAL_DOCUMENT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_TECHNICAL_DOCUMENT_BYTES) {
      throw new Error("technical document must not exceed 2 MiB");
    }
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("technical document must be valid UTF-8");
  }
}

function extractCitations(markdown) {
  const citations = [];
  const seenRanges = [];
  const add = (file, line, index, length) => {
    if (seenRanges.some(([start, end]) => index >= start && index < end)) return;
    citations.push({ file, line: Number(line) });
    seenRanges.push([index, index + length]);
  };

  for (const match of markdown.matchAll(/`([^`\r\n]+):([1-9]\d*)`/gu)) {
    add(match[1], match[2], match.index, match[0].length);
  }
  const barePattern = /(?:^|[\s([])((?:file:\/\/\/|[A-Za-z]:[\\/]|\/|\.\.\/|[A-Za-z0-9_.-]+[\\/])[^\s)`\]]*?):([1-9]\d*)(?=$|[\s),.;\]])/gmu;
  for (const match of markdown.matchAll(barePattern)) {
    const prefixLength = match[0].length - `${match[1]}:${match[2]}`.length;
    add(match[1], match[2], match.index + prefixLength, match[0].length - prefixLength);
  }
  return citations;
}

function withoutFencedCode(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/u).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] ?? null;
    if (!fence && marker) {
      fence = { character: marker[0], length: marker.length };
      return "";
    }
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1] ?? null;
      if (closing && closing[0] === fence.character && closing.length >= fence.length) fence = null;
      return "";
    }
    return line;
  });
}

export async function readTechnicalEvidenceManifest(projectRoot, manifestPath, evidencePath, expectedQuery) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await realpath(absoluteProjectRoot);
  for (const candidate of [manifestPath, evidencePath]) {
    const absoluteCandidate = path.resolve(candidate);
    if (!isSameOrDescendant(absoluteProjectRoot, absoluteCandidate)) {
      throw new Error("technical evidence files must be inside the project");
    }
    const canonicalCandidate = await realpath(absoluteCandidate);
    if (!isSameOrDescendant(canonicalProjectRoot, canonicalCandidate)) {
      throw new Error("technical evidence files must be inside the project");
    }
  }
  const manifestText = await readTechnicalDocument(manifestPath);
  const evidenceText = await readTechnicalDocument(evidencePath);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("technical evidence manifest must be valid JSON");
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object"
    || Object.keys(manifest).sort().join(",") !== "evidenceSha256,query,schemaVersion,sourceFiles") {
    throw new Error("technical evidence manifest has an invalid structure");
  }
  if (manifest.schemaVersion !== TECHNICAL_MANIFEST_SCHEMA_VERSION) {
    throw new Error("technical evidence manifest has an unsupported version");
  }
  if (manifest.query !== expectedQuery) throw new Error("technical evidence manifest query does not match");
  const actualHash = createHash("sha256").update(evidenceText).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(manifest.evidenceSha256) || manifest.evidenceSha256 !== actualHash) {
    throw new Error("technical evidence dossier does not match its prepared manifest");
  }
  if (!Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length > MAX_NODES) {
    throw new Error("technical evidence manifest source files are invalid");
  }
  const sourceFiles = new Set();
  for (const file of manifest.sourceFiles) {
    if (typeof file !== "string" || citationPathIsUnsafe(file) || sourceFiles.has(file)) {
      throw new Error("technical evidence manifest source files are invalid");
    }
    sourceFiles.add(file);
  }
  return sourceFiles;
}

function citationPathIsUnsafe(file) {
  if (!file || file.includes("\\") || file.includes("\0")) return true;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(file)) return true;
  const segments = file.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

async function sourceLineCount(filePath) {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("citation source must be a regular file");
    if (metadata.size > MAX_CITATION_SOURCE_BYTES) {
      throw new Error("citation source changed or exceeds the 5 MiB analysis limit");
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    let lineBreaks = 0;
    let previousWasCr = false;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, offset);
      if (result.bytesRead === 0) break;
      for (let index = 0; index < result.bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === 0x0d) lineBreaks += 1;
        else if (byte === 0x0a && !previousWasCr) lineBreaks += 1;
        previousWasCr = byte === 0x0d;
      }
      offset += result.bytesRead;
      if (offset > MAX_CITATION_SOURCE_BYTES) {
        throw new Error("citation source changed or exceeds the 5 MiB analysis limit");
      }
    }
    return lineBreaks + 1;
  } finally {
    await handle.close();
  }
}

export async function validateTechnicalDocument(projectRoot, documentPath, { allowedFiles } = {}) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await realpath(absoluteProjectRoot);
  const absoluteDocumentPath = path.resolve(documentPath);
  if (!isSameOrDescendant(absoluteProjectRoot, absoluteDocumentPath)) {
    throw new Error("technical document must be inside the project");
  }
  const markdown = await readTechnicalDocument(absoluteDocumentPath);
  const canonicalDocumentPath = await realpath(absoluteDocumentPath);
  if (!isSameOrDescendant(canonicalProjectRoot, canonicalDocumentPath)) {
    throw new Error("technical document must be inside the project");
  }

  const errors = [];
  const lines = withoutFencedCode(markdown);
  let present = 0;
  let withEvidence = 0;
  for (const heading of REQUIRED_TECHNICAL_HEADINGS) {
    const indexes = lines.flatMap((line, index) => line === heading ? [index] : []);
    const count = indexes.length;
    if (count === 0) errors.push(`missing required heading: ${heading}`);
    else {
      present += 1;
      if (count > 1) errors.push(`duplicate required heading: ${heading}`);
      const start = indexes[0] + 1;
      const end = lines.findIndex((line, index) => index >= start && /^##\s/u.test(line));
      const section = lines.slice(start, end === -1 ? lines.length : end).join("\n");
      if (extractCitations(section).length > 0 || /\bNeeds verification\b/u.test(section)) withEvidence += 1;
      else errors.push(`section requires a citation or Needs verification: ${heading}`);
    }
  }

  const visibleMarkdown = lines.join("\n");
  const citations = extractCitations(visibleMarkdown);
  if (citations.length === 0) errors.push("document must contain at least one project-relative citation");
  const citedFiles = new Set();
  const allowed = allowedFiles === undefined ? null : new Set(allowedFiles);
  const lineCounts = new Map();
  for (const citation of citations) {
    if (citationPathIsUnsafe(citation.file)) {
      errors.push(`unsafe citation path: ${citation.file}`);
      continue;
    }
    if (allowed && !allowed.has(citation.file)) {
      errors.push(`citation file is outside prepared evidence: ${citation.file}`);
      continue;
    }
    const candidate = path.resolve(canonicalProjectRoot, ...citation.file.split("/"));
    if (!isSameOrDescendant(canonicalProjectRoot, candidate)) {
      errors.push(`unsafe citation path: ${citation.file}`);
      continue;
    }
    try {
      const entry = await lstat(candidate);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        errors.push(`citation file is not a regular file: ${citation.file}`);
        continue;
      }
      const canonicalCandidate = await realpath(candidate);
      if (!isSameOrDescendant(canonicalProjectRoot, canonicalCandidate)) {
        errors.push(`unsafe citation path: ${citation.file}`);
        continue;
      }
      let lineCount = lineCounts.get(citation.file);
      if (lineCount === undefined) {
        lineCount = await sourceLineCount(canonicalCandidate);
        lineCounts.set(citation.file, lineCount);
      }
      if (citation.line > lineCount) {
        errors.push(`citation line is outside file: ${citation.file}:${citation.line} (file has ${lineCount} lines)`);
        continue;
      }
      citedFiles.add(citation.file);
    } catch (error) {
      if (error?.code === "ENOENT") errors.push(`citation file does not exist: ${citation.file}`);
      else throw error;
    }
  }

  return {
    ok: errors.length === 0,
    file: path.relative(canonicalProjectRoot, canonicalDocumentPath).replaceAll("\\", "/"),
    bytes: Buffer.byteLength(markdown),
    sections: { present, required: REQUIRED_TECHNICAL_HEADINGS.length, withEvidence },
    citations: { total: citations.length, files: citedFiles.size },
    markers: {
      derived: (markdown.match(/\bDerived\b/gu) ?? []).length,
      needsVerification: (markdown.match(/\bNeeds verification\b/gu) ?? []).length,
    },
    errors,
  };
}
