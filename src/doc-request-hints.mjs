import { compareText } from "./compare.mjs";

export function evidenceEntries(entry) {
  const evidence = entry?.evidence ?? entry;
  return Array.isArray(evidence) ? evidence : [evidence];
}

export function evidenceLocations(entry) {
  return evidenceEntries(entry)
    .filter((candidate) => candidate
      && typeof candidate.file === "string"
      && Number.isInteger(candidate.line)
      && Number.isInteger(candidate.column))
    .map((candidate) => ({
      file: candidate.file,
      line: candidate.line,
      column: candidate.column,
    }));
}

export function evidenceLocationKey({ file, line, column }) {
  return `${file}\0${line}\0${column}`;
}


// Request-hint handling for document generation: reading a route's
// configured request hints (method, parameters, evidence) and summarizing
// them for use cases and page specs. Moved out of the document model so
// that file can shrink; the only consumer is buildDocumentModel.

function requestHintSignature(hint) {
  const parameters = Object.fromEntries(
    Object.entries(hint?.parameters ?? {}).sort(([left], [right]) => compareText(left, right)),
  );
  return JSON.stringify({
    method: typeof hint?.method === "string" ? hint.method.toUpperCase() : "",
    dispatchMethod: typeof hint?.dispatchMethod === "string" ? hint.dispatchMethod : "",
    parameters,
    parametersComplete: typeof hint?.parametersComplete === "boolean"
      ? hint.parametersComplete
      : null,
    hasDynamicParameterNames: hint?.hasDynamicParameterNames === true,
  });
}

function addHintIndexEntry(index, key, entry) {
  const entries = index.get(key) ?? [];
  entries.push(entry);
  index.set(key, entries);
}

function buildRequestHintIndex(route) {
  const hints = Array.isArray(route.data?.requestHints) ? route.data.requestHints : [];
  let hasLocatedHint = false;
  const byLocation = new Map();
  const byFile = new Map();
  for (let order = 0; order < hints.length; order += 1) {
    const hint = hints[order];
    const hintLocations = evidenceLocations(hint);
    hasLocatedHint ||= hintLocations.length > 0;
    const locationKeys = new Set(hintLocations.map(evidenceLocationKey));
    const files = new Set(hintLocations.map(({ file }) => file));
    const entry = { hint, order };
    for (const key of locationKeys) addHintIndexEntry(byLocation, key, entry);
    for (const file of files) addHintIndexEntry(byFile, file, entry);
  }
  return {
    hints,
    hasLocatedHint,
    byLocation,
    byFile,
    fallback: !hasLocatedHint && new Set(hints.map(requestHintSignature)).size === 1
      ? hints.slice(0, 1)
      : [],
  };
}

export function requestHintIndex(route, indexes) {
  if (indexes === null) return buildRequestHintIndex(route);
  let index = indexes.get(route.id);
  if (!index) {
    index = buildRequestHintIndex(route);
    indexes.set(route.id, index);
  }
  return index;
}

export function requestHints(route, source = null, indexes = null) {
  const index = requestHintIndex(route, indexes);
  if (source === null) return index.hints;
  const matched = new Map();
  for (const location of evidenceLocations(source)) {
    for (const entry of index.byLocation.get(evidenceLocationKey(location)) ?? []) {
      matched.set(entry.order, entry.hint);
    }
  }
  if (matched.size > 0) {
    return [...matched].sort(([left], [right]) => left - right).map(([, hint]) => hint);
  }
  return index.hasLocatedHint ? [] : index.fallback;
}

function requestHintsForFile(route, file, indexes) {
  return (requestHintIndex(route, indexes).byFile.get(file) ?? []).map(({ hint }) => hint);
}

export function requestParametersComplete(hints) {
  return hints.some((hint) => {
    if (hint?.parametersComplete === true) return true;
    if (hint?.parametersComplete === false) return false;
    return Object.values(hint?.parameters ?? {}).some((value) => value === "");
  });
}

export function uniquePageIdsByPath(nodes) {
  const pageIds = new Map();
  for (const node of nodes) {
    if (node.type !== "page" || typeof node.filePath !== "string") continue;
    if (pageIds.has(node.filePath)) pageIds.set(node.filePath, null);
    else pageIds.set(node.filePath, node.id);
  }
  return pageIds;
}

export function requestHintPageId(hint, pageIdByPath) {
  let resolved = null;
  const locations = evidenceLocations(hint);
  if (locations.length === 0) return null;
  for (const { file } of locations) {
    const pageId = pageIdByPath.get(file);
    if (typeof pageId !== "string") return null;
    if (resolved !== null && resolved !== pageId) return null;
    resolved = pageId;
  }
  return resolved;
}

export function summarizeRequestHints(hints) {
  const methods = new Set();
  const parameters = new Set();
  let hasUnknownMethod = false;
  let hasDynamicParameterNames = false;
  for (const hint of hints) {
    if (typeof hint?.method === "string" && hint.method) methods.add(hint.method.toUpperCase());
    else hasUnknownMethod = true;
    if (hint?.hasDynamicParameterNames === true) hasDynamicParameterNames = true;
    for (const name of Object.keys(hint?.parameters ?? {})) parameters.add(name);
  }
  return {
    methods: [...methods].sort(compareText),
    parameters: [...parameters].sort(compareText),
    hasUnknownMethod,
    ...(hasDynamicParameterNames ? { hasDynamicParameterNames: true } : {}),
  };
}

export function requestSummary(route, source = null, requestHintIndexes = null) {
  return summarizeRequestHints(requestHints(route, source, requestHintIndexes));
}

function hasFormRequestEvidence(hint) {
  return evidenceEntries(hint).some((entry) => {
    if (typeof entry?.snippet !== "string" || !Number.isInteger(entry.column)) return false;
    const evidenceOffset = entry.column - 1;
    const openingForm = /<\s*(?:form|html:form|s:form|form:form)(?=[\s/>])[^>]*>/giu;
    return [...entry.snippet.matchAll(openingForm)].some((match) => (
      evidenceOffset >= match.index && evidenceOffset < match.index + match[0].length
    ));
  });
}

export function submissionRequestHints(route, edge, page, actionEdges, requestHintIndexes) {
  const matched = requestHints(route, edge, requestHintIndexes);
  if (matched.length === 0) return { hints: matched, defaultsReliable: true };
  const actionTypes = new Set(
    actionEdges.filter((candidate) => candidate.target === edge.target).map((candidate) => candidate.type),
  );
  const pagePath = page.filePath ?? page.name;
  const samePageHints = requestHintsForFile(route, pagePath, requestHintIndexes)
    .filter((hint) => actionTypes.size === 1 || hasFormRequestEvidence(hint));
  const hints = [...new Set([...matched, ...samePageHints])];
  const exactHints = new Set(matched);
  return {
    hints,
    defaultsReliable: hints.every((hint) => exactHints.has(hint)),
  };
}
