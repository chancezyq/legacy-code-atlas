import { createHash } from "node:crypto";

import { searchGraph, traverseGraph } from "./query.mjs";
import { normalizeConfiguredOutcome } from "./outcome-metadata.mjs";
import { effectiveTilePages } from "./tile-composition.mjs";

const MAX_USE_CASES = 200;
const MAX_PAGES = 200;
const MAX_TRIGGERS_PER_USE_CASE = 20;
const MAX_FLOW_STEPS = 24;
const MAX_ALTERNATE_FLOWS = 8;
const MAX_ACTIONS_PER_PAGE = 40;
const MAX_ARRIVALS_PER_PAGE = 20;
const MAX_TABLES_PER_USE_CASE = 20;
const MAX_FLOW_DEPTH = MAX_FLOW_STEPS - 1;
const FLOW_EDGE_TYPES = [
  "maps_to",
  "dispatches_to",
  "forwards_to",
  "redirects_to",
  "uses_tile",
  "calls",
  "calls_procedure",
  "implements",
  "implemented_by",
  "uses_statement",
  "reads_from",
  "writes_to",
  "extends",
  "extends_tile",
  "uses_template",
  "puts",
];
const TRIGGER_EDGE_TYPES = new Set(["submits_to", "links_to", "requests"]);
const FEATURE_PAGE_TRIGGER_EDGE_TYPES = new Set(["submits_to", "requests"]);
const OUTCOME_EDGE_TYPES = new Set(["forwards_to", "redirects_to"]);
const PAGE_ACTION_EDGE_TYPES = new Set(["submits_to", "links_to", "requests"]);
const REQUEST_HINT_EDGE_TYPES = new Set(["submits_to", "links_to", "requests"]);
const PAGE_ARRIVAL_EDGE_TYPES = new Set([
  "forwards_to",
  "redirects_to",
  "includes",
  "uses_tile",
  "puts",
  "uses_template",
]);
const TILE_COMPOSITION_EDGE_TYPES = new Set(["extends_tile", "puts", "uses_template"]);
const USE_CASE_ENTRY_EDGE_TYPES = new Set(["contains", "redirects_to", "submits_to", "requests"]);
const DATA_FLOW_NODE_TYPES = new Set(["statement", "procedure", "table"]);
const BRANCH_DETAIL_NODE_TYPES = new Set([
  "java_type",
  "java_method",
  "page",
  "route",
  "tiles_definition",
  ...DATA_FLOW_NODE_TYPES,
]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function firstEvidence(entry) {
  const evidenceValue = entry?.evidence ?? entry;
  const evidence = Array.isArray(evidenceValue) ? evidenceValue[0] : evidenceValue;
  if (!evidence || typeof evidence.file !== "string" || !Number.isInteger(evidence.line)) return null;
  return { file: evidence.file, line: evidence.line };
}

function outcomeFields(edge) {
  const outcome = normalizeConfiguredOutcome(edge);
  if (!outcome) return {};
  return {
    ...(outcome.framework ? { framework: outcome.framework } : {}),
    resultName: outcome.name,
    classification: outcome.classification,
    configEvidence: firstEvidence(edge),
    codeEvidence: outcome.codeEvidence.map(firstEvidence).filter(Boolean),
  };
}

function buildTileArrivalOutcomeIndex(edges, nodeById, outgoingBySource) {
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const ownersByArrivalEdgeId = new Map();
  for (const edge of edges) {
    if (edge.type !== "uses_tile" || nodeById.get(edge.target)?.type !== "tiles_definition") continue;
    for (const composition of effectiveTilePages(edge.target, nodeById, outgoingBySource)) {
      const arrivalEdge = composition.edges.at(-1);
      if (!arrivalEdge || !TILE_COMPOSITION_EDGE_TYPES.has(arrivalEdge.type)) continue;
      const owners = ownersByArrivalEdgeId.get(arrivalEdge.id) ?? new Map();
      owners.set(edge.id, edge);
      ownersByArrivalEdgeId.set(arrivalEdge.id, owners);
    }
  }

  const outcomes = new Map();
  for (const [arrivalEdgeId, ownersById] of ownersByArrivalEdgeId) {
    const owners = [...ownersById.values()];
    if (owners.length === 1) {
      outcomes.set(arrivalEdgeId, outcomeFields(owners[0]));
      continue;
    }
    const arrivalEdge = edgeById.get(arrivalEdgeId);
    outcomes.set(arrivalEdgeId, {
      resultName: "",
      classification: "configured-candidate",
      configEvidence: firstEvidence(arrivalEdge),
      codeEvidence: [],
    });
  }
  return outcomes;
}

function moduleNameForRoute(url) {
  const withoutQuery = String(url ?? "").split(/[?#]/, 1)[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  if (segments.length === 0) return "root";
  if (segments.length === 1) return "root";
  return segments[0].replaceAll("*", "").trim() || "root";
}

function accessLabel(reads, writes) {
  if (reads && writes) return "read-write";
  return writes ? "write" : "read";
}

function evidenceEntries(entry) {
  const evidence = entry?.evidence ?? entry;
  return Array.isArray(evidence) ? evidence : [evidence];
}

function evidenceLocations(entry) {
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

function evidenceLocationKey({ file, line, column }) {
  return `${file}\0${line}\0${column}`;
}

function scriptRequestEvidenceForPage(edge, pageId) {
  const contexts = Array.isArray(edge.data?.requestContexts) ? edge.data.requestContexts : null;
  if (contexts) {
    const pageIdsByEvidence = new Map(contexts.map((context) => [
      evidenceLocationKey(context),
      Array.isArray(context.pageIds) ? context.pageIds : [],
    ]));
    return evidenceEntries(edge).filter((entry) => {
      const pageIds = pageIdsByEvidence.get(evidenceLocationKey(entry));
      return pageIds === undefined || pageIds.includes(pageId);
    });
  }
  const pageIds = Array.isArray(edge.data?.pageIds) ? edge.data.pageIds : null;
  return pageIds && !pageIds.includes(pageId) ? [] : evidenceEntries(edge);
}

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

function requestHintIndex(route, indexes) {
  if (indexes === null) return buildRequestHintIndex(route);
  let index = indexes.get(route.id);
  if (!index) {
    index = buildRequestHintIndex(route);
    indexes.set(route.id, index);
  }
  return index;
}

function requestHints(route, source = null, indexes = null) {
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

function requestParametersComplete(hints) {
  return hints.some((hint) => {
    if (hint?.parametersComplete === true) return true;
    if (hint?.parametersComplete === false) return false;
    return Object.values(hint?.parameters ?? {}).some((value) => value === "");
  });
}

function uniquePageIdsByPath(nodes) {
  const pageIds = new Map();
  for (const node of nodes) {
    if (node.type !== "page" || typeof node.filePath !== "string") continue;
    if (pageIds.has(node.filePath)) pageIds.set(node.filePath, null);
    else pageIds.set(node.filePath, node.id);
  }
  return pageIds;
}

function requestHintPageId(hint, pageIdByPath) {
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

function summarizeRequestHints(hints) {
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

function requestSummary(route, source = null, requestHintIndexes = null) {
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

function submissionRequestHints(route, edge, page, actionEdges, requestHintIndexes) {
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

function useCaseOutcomes(route, nodeById, outgoingBySource) {
  const outcomes = [];
  for (const edge of outgoingBySource.get(route.id) ?? []) {
    if (edge.type === "uses_tile") {
      for (const composition of effectiveTilePages(edge.target, nodeById, outgoingBySource)) {
        const pathEdges = [edge, ...composition.edges];
        outcomes.push({
          kind: "composes",
          target: composition.node.name,
          targetId: composition.node.id,
          targetPath: composition.node.filePath ?? composition.node.name,
          targetType: composition.node.type,
          reason: pathEdges.map((pathEdge) => pathEdge.type).join(" -> "),
          confidence: pathEdges.reduce(
            (minimum, pathEdge) => Math.min(
              minimum,
              typeof pathEdge.confidence === "number" ? pathEdge.confidence : 1,
            ),
            1,
          ),
          evidence: firstEvidence(pathEdges.at(-1)) ?? firstEvidence(edge),
          ...outcomeFields(edge),
        });
      }
      continue;
    }
    if (!OUTCOME_EDGE_TYPES.has(edge.type)) continue;
    const target = nodeById.get(edge.target);
    if (!target) continue;
    outcomes.push({
      kind: edge.type,
      target: target.name,
      targetId: target.id,
      targetPath: target.filePath ?? target.name,
      targetType: target.type,
      reason: edge.reason ?? "",
      confidence: typeof edge.confidence === "number" ? edge.confidence : 1,
      evidence: firstEvidence(edge),
      ...outcomeFields(edge),
    });
  }
  return outcomes.sort((left, right) => compareText(left.reason, right.reason)
    || compareText(left.target, right.target));
}

function useCaseInputs(triggers, nodeById, outgoingBySource, requestHintsByTrigger, pageIdByPath) {
  const inputs = [];
  const seen = new Set();
  const add = (name) => {
    const value = String(name);
    if (seen.has(value)) return;
    seen.add(value);
    inputs.push(value);
  };
  const pageScopes = new Map();
  const mergePageScope = (pageId, names) => {
    if (!pageScopes.has(pageId)) {
      pageScopes.set(pageId, names === null ? null : new Set(names));
      return;
    }
    const current = pageScopes.get(pageId);
    if (current === null || names === null) {
      pageScopes.set(pageId, null);
      return;
    }
    for (const name of names) current.add(name);
  };
  const submissionEdgeCounts = new Map();
  for (const trigger of triggers) {
    if (trigger.kind !== "submits_to") continue;
    let submissionEdgeCount = submissionEdgeCounts.get(trigger.pageId);
    if (submissionEdgeCount === undefined) {
      submissionEdgeCount = (outgoingBySource.get(trigger.pageId) ?? [])
        .filter((edge) => edge.type === "submits_to").length;
      submissionEdgeCounts.set(trigger.pageId, submissionEdgeCount);
    }
    const hints = requestHintsByTrigger.get(trigger) ?? [];
    let needsOwnerFallback = hints.length === 0;
    for (const hint of hints) {
      const parameters = new Set(summarizeRequestHints([hint]).parameters);
      const complete = requestParametersComplete([hint]);
      const hasDynamicParameterNames = hint?.hasDynamicParameterNames === true;
      const sourcePageId = requestHintPageId(hint, pageIdByPath);
      if (sourcePageId !== null) {
        mergePageScope(sourcePageId, complete || hasDynamicParameterNames ? parameters : null);
      } else if (!complete && hint?.parametersComplete !== false) {
        needsOwnerFallback = true;
      }
    }
    if (needsOwnerFallback && submissionEdgeCount === 1) {
      mergePageScope(trigger.pageId, null);
    }
  }
  for (const [pageId, scopedNames] of pageScopes) {
    for (const field of nodeById.get(pageId)?.data?.fields ?? []) {
      if (scopedNames === null || scopedNames.has(String(field))) add(field);
    }
  }
  for (const trigger of triggers) {
    if (trigger.kind !== "submits_to") continue;
    for (const name of trigger.requestParameters) add(name);
  }
  return inputs;
}

function useCaseStatements(traversal) {
  const statements = [];
  for (const node of traversal.nodes) {
    if (node.type !== "statement") continue;
    statements.push({
      id: node.name,
      operation: typeof node.data?.type === "string" ? node.data.type : "",
    });
  }
  return statements.sort((left, right) => compareText(left.id, right.id));
}

function buildUseCase(
  graph,
  route,
  nodeById,
  incomingByTarget,
  outgoingBySource,
  pageIdByPath,
  requestHintIndexes,
) {
  const triggers = [];
  const requestHintsByTrigger = new WeakMap();
  for (const edge of incomingByTarget.get(route.id) ?? []) {
    if (!TRIGGER_EDGE_TYPES.has(edge.type)) continue;
    const source = nodeById.get(edge.source);
    if (!source || source.type !== "page") continue;
    const matchedRequestHints = requestHints(route, edge, requestHintIndexes);
    const trigger = {
      kind: edge.type,
      pageId: source.id,
      pagePath: source.filePath ?? source.name,
      pageName: source.name,
      confidence: typeof edge.confidence === "number" ? edge.confidence : 1,
      evidence: firstEvidence(edge),
      requestParameters: summarizeRequestHints(matchedRequestHints).parameters,
      parametersComplete: requestParametersComplete(matchedRequestHints),
    };
    requestHintsByTrigger.set(trigger, matchedRequestHints);
    triggers.push(trigger);
  }
  triggers.sort((left, right) => compareText(left.pagePath, right.pagePath) || compareText(left.kind, right.kind));

  const traversal = traverseGraph(graph, [route.id], {
    direction: "outgoing",
    maxDepth: MAX_FLOW_DEPTH,
    allowedEdgeTypes: FLOW_EDGE_TYPES,
  });
  const edgeById = new Map(traversal.edges.map((edge) => [edge.id, edge]));
  const mainPath = traversal.paths[0] ?? { nodes: [route.id], edges: [], edgeIds: [] };

  const flowSteps = (flowPath) => {
    const steps = [];
    const flowNodeIds = flowPath.nodes.slice(0, MAX_FLOW_STEPS);
    for (let index = 0; index < flowNodeIds.length; index += 1) {
      const node = nodeById.get(flowNodeIds[index]);
      const viaEdge = index > 0 ? edgeById.get(flowPath.edgeIds[index - 1]) : null;
      steps.push({
        index: index + 1,
        nodeId: flowNodeIds[index],
        nodeType: node?.type ?? "unknown",
        name: node?.name ?? flowNodeIds[index],
        via: viaEdge?.type ?? null,
        confidence: typeof viaEdge?.confidence === "number" ? viaEdge.confidence : 1,
        evidence: firstEvidence(viaEdge) ?? firstEvidence(node),
        ...outcomeFields(viaEdge),
      });
    }
    return steps;
  };
  const mainFlow = flowSteps(mainPath);
  const flowConfidence = (steps) => steps.reduce(
    (minimum, step) => Math.min(minimum, step.confidence),
    1,
  );
  const minConfidence = flowConfidence(mainFlow);
  const representedBranchNodes = new Set(
    mainFlow
      .filter((step, index) => index > 0 && BRANCH_DETAIL_NODE_TYPES.has(step.nodeType))
      .map((step) => step.nodeId),
  );
  const alternateFlowCandidates = [];
  for (const flowPath of traversal.paths.slice(1)) {
    const branchNodeIds = flowPath.nodes.slice(1).filter((nodeId) => (
      BRANCH_DETAIL_NODE_TYPES.has(nodeById.get(nodeId)?.type)
    ));
    if (branchNodeIds.length === 0
      || branchNodeIds.every((nodeId) => representedBranchNodes.has(nodeId))) {
      continue;
    }
    alternateFlowCandidates.push(flowPath);
    for (const nodeId of branchNodeIds) representedBranchNodes.add(nodeId);
  }
  const alternateFlows = alternateFlowCandidates.slice(0, MAX_ALTERNATE_FLOWS).map(flowSteps);
  const alternateFlowConfidences = alternateFlows.map(flowConfidence);

  const tableAccess = new Map();
  for (const edge of traversal.edges) {
    if (edge.type !== "reads_from" && edge.type !== "writes_to") continue;
    const table = nodeById.get(edge.target);
    if (!table || table.type !== "table") continue;
    const entry = tableAccess.get(table.name) ?? { reads: false, writes: false };
    if (edge.type === "reads_from") entry.reads = true;
    else entry.writes = true;
    tableAccess.set(table.name, entry);
  }
  const allTables = [...tableAccess.entries()]
    .map(([name, entry]) => ({ name, access: accessLabel(entry.reads, entry.writes) }))
    .sort((left, right) => compareText(left.name, right.name));
  const tables = allTables.slice(0, MAX_TABLES_PER_USE_CASE);
  const flowDisplayTruncated = traversal.depthLimitReached
    || mainPath.nodes.length > MAX_FLOW_STEPS;
  const flowTraversalTruncated = traversal.pathLimitReached
    || traversal.stateLimitReached;

  return {
    route: route.name,
    routeId: route.id,
    module: moduleNameForRoute(route.name),
    evidence: firstEvidence(route),
    request: requestSummary(route, null, requestHintIndexes),
    triggers: triggers.slice(0, MAX_TRIGGERS_PER_USE_CASE),
    triggersTruncated: triggers.length > MAX_TRIGGERS_PER_USE_CASE,
    inputs: useCaseInputs(
      triggers,
      nodeById,
      outgoingBySource,
      requestHintsByTrigger,
      pageIdByPath,
    ),
    outcomes: useCaseOutcomes(route, nodeById, outgoingBySource),
    mainFlow,
    alternateFlows,
    alternateFlowConfidences,
    alternateFlowsTruncated: alternateFlowCandidates.length > MAX_ALTERNATE_FLOWS,
    flowTruncated: flowDisplayTruncated
      || flowTraversalTruncated
      || alternateFlowCandidates.length > MAX_ALTERNATE_FLOWS,
    flowDisplayTruncated,
    flowTraversalTruncated,
    statements: useCaseStatements(traversal),
    tables,
    tablesTruncated: allTables.length > MAX_TABLES_PER_USE_CASE,
    minConfidence,
  };
}

function pageFieldSpecs(page, defaultCandidates) {
  const names = (Array.isArray(page.data?.fields) ? page.data.fields : []).map(String);
  const occurrences = new Map();
  for (const name of names) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
  return names.map((name) => {
    const candidate = defaultCandidates.get(name);
    return {
      name,
      defaultValue: candidate?.values.size === 1
        && candidate.observations === occurrences.get(name)
        ? candidate.values.values().next().value
        : "",
    };
  });
}

function buildPageSpec(
  page,
  nodeById,
  outgoingBySource,
  incomingByTarget,
  requestHintIndexes,
  tileArrivalOutcomes,
) {
  const actions = [];
  const defaultCandidates = new Map();
  const actionEdges = (outgoingBySource.get(page.id) ?? [])
    .filter((edge) => PAGE_ACTION_EDGE_TYPES.has(edge.type));
  for (const edge of actionEdges) {
    const target = nodeById.get(edge.target);
    if (!target) continue;
    const hintSelection = edge.type === "submits_to"
      ? submissionRequestHints(target, edge, page, actionEdges, requestHintIndexes)
      : {
          hints: REQUEST_HINT_EDGE_TYPES.has(edge.type)
            ? requestHints(target, edge, requestHintIndexes)
            : [],
          defaultsReliable: true,
        };
    const matchedHints = hintSelection.hints;
    if (edge.type === "submits_to" && hintSelection.defaultsReliable) {
      for (const hint of matchedHints) {
        for (const [name, value] of Object.entries(hint?.parameters ?? {})) {
          if (typeof value !== "string" || !value) continue;
          const candidate = defaultCandidates.get(name) ?? { values: new Set(), observations: 0 };
          candidate.values.add(value);
          candidate.observations += 1;
          defaultCandidates.set(name, candidate);
        }
      }
    }
    const actionHints = REQUEST_HINT_EDGE_TYPES.has(edge.type) && matchedHints.length > 0
      ? matchedHints
      : [null];
    for (const hint of actionHints) {
      const methods = hint ? summarizeRequestHints([hint]).methods : [];
      actions.push({
        kind: edge.type,
        target: target.name,
        targetId: target.id,
        targetType: target.type,
        confidence: typeof edge.confidence === "number" ? edge.confidence : 1,
        method: methods.join("/"),
        evidence: firstEvidence(hint) ?? firstEvidence(edge),
      });
    }
  }
  actions.sort((left, right) => compareText(left.target, right.target)
    || compareText(left.kind, right.kind)
    || compareText(left.method, right.method)
    || compareText(left.evidence?.file ?? "", right.evidence?.file ?? "")
    || (left.evidence?.line ?? 0) - (right.evidence?.line ?? 0));

  const arrivals = [];
  for (const edge of incomingByTarget.get(page.id) ?? []) {
    if (!PAGE_ARRIVAL_EDGE_TYPES.has(edge.type)) continue;
    const source = nodeById.get(edge.source);
    if (!source) continue;
    arrivals.push({
      kind: edge.type,
      from: source.name,
      fromType: source.type,
      evidence: firstEvidence(edge),
      ...outcomeFields(edge),
      ...(tileArrivalOutcomes.get(edge.id) ?? {}),
    });
  }
  arrivals.sort((left, right) => compareText(left.from, right.from) || compareText(left.kind, right.kind));

  return {
    pageId: page.id,
    filePath: page.filePath ?? page.name,
    name: page.name,
    visibleText: String(page.data?.visibleText ?? ""),
    fields: pageFieldSpecs(page, defaultCandidates),
    actions: actions.slice(0, MAX_ACTIONS_PER_PAGE),
    actionsTruncated: actions.length > MAX_ACTIONS_PER_PAGE,
    arrivals: arrivals.slice(0, MAX_ARRIVALS_PER_PAGE),
    arrivalsTruncated: arrivals.length > MAX_ARRIVALS_PER_PAGE,
  };
}

function isUseCaseRoute(route, incomingByTarget, outgoingBySource) {
  return (incomingByTarget.get(route.id) ?? []).some((edge) => USE_CASE_ENTRY_EDGE_TYPES.has(edge.type))
    || (outgoingBySource.get(route.id) ?? []).some((edge) => FLOW_EDGE_TYPES.includes(edge.type));
}

const MAX_SCOPE_SLUG_CHARACTERS = 48;
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

export function scopeSlug(query) {
  const normalized = String(query ?? "").normalize("NFKC").toLowerCase().trim();
  if (!normalized) return "scope";
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)
    && normalized.length <= MAX_SCOPE_SLUG_CHARACTERS
    && !WINDOWS_RESERVED_FILE_NAME.test(normalized)) return normalized;

  const readable = normalized
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "scope";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const prefixLength = MAX_SCOPE_SLUG_CHARACTERS - digest.length - 2;
  const prefix = readable.slice(0, prefixLength).replace(/-+$/gu, "") || "scope";
  return `${prefix}--${digest}`;
}

function normalizedScopeText(value) {
  return String(value).normalize("NFKC").toLowerCase().trim();
}

function resolveScope(query, routes) {
  const normalized = String(query).normalize("NFKC").toLowerCase().trim();
  const moduleNames = new Set(routes.map((route) => normalizedScopeText(moduleNameForRoute(route.name))));
  if (moduleNames.has(normalized)) {
    return { kind: "module", query: String(query).trim(), matched: true, slug: scopeSlug(query) };
  }
  return { kind: "feature", query: String(query).trim(), matched: false, slug: scopeSlug(query) };
}

function featureRouteIds(graph, query, nodeById, incomingByTarget, outgoingBySource) {
  const matches = searchGraph(graph, query, { limit: graph.nodes.length });
  const routeIds = new Set();
  const queue = [];
  const visited = new Set();
  const enqueue = (nodeId) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    queue.push(nodeId);
  };

  for (const match of matches) {
    enqueue(match.id);
    if (match.type !== "page") continue;
    for (const edge of outgoingBySource.get(match.id) ?? []) {
      if (!FEATURE_PAGE_TRIGGER_EDGE_TYPES.has(edge.type)
        || nodeById.get(edge.target)?.type !== "route") continue;
      routeIds.add(edge.target);
    }
  }

  const allowedEdges = new Set([...FLOW_EDGE_TYPES, "includes"]);
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (nodeById.get(nodeId)?.type === "route") routeIds.add(nodeId);
    for (const edge of incomingByTarget.get(nodeId) ?? []) {
      if (allowedEdges.has(edge.type)) enqueue(edge.source);
    }
  }
  return routeIds;
}

function scopedRoutes(scope, graph, routes, nodeById, incomingByTarget, outgoingBySource) {
  let candidates;
  if (scope.kind === "module") {
    const wanted = normalizedScopeText(scope.query);
    candidates = routes.filter((route) => normalizedScopeText(moduleNameForRoute(route.name)) === wanted);
  } else {
    const routeIds = featureRouteIds(graph, scope.query, nodeById, incomingByTarget, outgoingBySource);
    candidates = routes.filter((route) => routeIds.has(route.id));
  }
  scope.matched = candidates.length > 0;
  return candidates;
}

function scopedPageIds(useCases, nodeById, incomingByTarget, outgoingBySource) {
  const pageIds = new Set();
  const visited = new Set();
  const queue = [];
  const enqueue = (nodeId) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    queue.push(nodeId);
  };
  for (const useCase of useCases) {
    for (const edge of incomingByTarget.get(useCase.routeId) ?? []) {
      if (PAGE_ACTION_EDGE_TYPES.has(edge.type) && nodeById.get(edge.source)?.type === "page") {
        pageIds.add(edge.source);
        enqueue(edge.source);
      }
    }
    enqueue(useCase.routeId);
  }
  const allowedEdges = new Set([...FLOW_EDGE_TYPES, "includes"]);
  for (let index = 0; index < queue.length; index += 1) {
    for (const edge of outgoingBySource.get(queue[index]) ?? []) {
      if (!allowedEdges.has(edge.type)) continue;
      if (edge.type === "uses_tile") {
        for (const composition of effectiveTilePages(edge.target, nodeById, outgoingBySource)) {
          pageIds.add(composition.node.id);
          enqueue(composition.node.id);
        }
        continue;
      }
      if (TILE_COMPOSITION_EDGE_TYPES.has(edge.type)) continue;
      if (nodeById.get(edge.target)?.type === "page") pageIds.add(edge.target);
      enqueue(edge.target);
    }
  }
  return pageIds;
}

export function buildDocumentModel(graph, options = {}) {
  if (options.scopeQuery !== undefined
    && (typeof options.scopeQuery !== "string" || !options.scopeQuery.trim())) {
    throw new TypeError("scopeQuery must be a non-empty string");
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError("document model requires a validated graph index");
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pageIdByPath = uniquePageIdsByPath(graph.nodes);
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  const indexEdge = (edge) => {
    const incoming = incomingByTarget.get(edge.target) ?? [];
    incoming.push(edge);
    incomingByTarget.set(edge.target, incoming);
    const outgoing = outgoingBySource.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingBySource.set(edge.source, outgoing);
  };
  const orderedEdges = [...graph.edges].sort((left, right) => compareText(left.id, right.id));
  for (const edge of orderedEdges) indexEdge(edge);
  const tileArrivalOutcomes = buildTileArrivalOutcomeIndex(
    orderedEdges,
    nodeById,
    outgoingBySource,
  );

  for (const loadEdge of orderedEdges) {
    if (loadEdge.type !== "loads_script" || nodeById.get(loadEdge.source)?.type !== "page") continue;
    for (const requestEdge of outgoingBySource.get(loadEdge.target) ?? []) {
      if (requestEdge.type !== "requests" || nodeById.get(requestEdge.target)?.type !== "route") continue;
      const evidence = scriptRequestEvidenceForPage(requestEdge, loadEdge.source);
      if (evidence.length === 0) continue;
      indexEdge({
        ...requestEdge,
        id: `${loadEdge.id}|via-script|${requestEdge.id}`,
        source: loadEdge.source,
        evidence,
        confidence: Math.min(loadEdge.confidence, requestEdge.confidence),
        reason: `${requestEdge.reason} via ${nodeById.get(loadEdge.target)?.name ?? loadEdge.target}`,
      });
    }
  }

  const allRoutes = graph.nodes
    .filter((node) => node.type === "route")
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
  const routes = allRoutes.filter((route) => isUseCaseRoute(route, incomingByTarget, outgoingBySource));
  const requestHintIndexes = new Map();
  let scope = null;
  let routeCandidates = routes;
  if (options.scopeQuery !== undefined) {
    scope = resolveScope(options.scopeQuery, routes);
    routeCandidates = scopedRoutes(
      scope,
      graph,
      routes,
      nodeById,
      incomingByTarget,
      outgoingBySource,
    );
  }
  const truncatedUseCases = routeCandidates.length > MAX_USE_CASES;
  const useCases = routeCandidates
    .slice(0, MAX_USE_CASES)
    .map((route) => buildUseCase(
      graph,
      route,
      nodeById,
      incomingByTarget,
      outgoingBySource,
      pageIdByPath,
      requestHintIndexes,
    ));

  const pageNodes = graph.nodes
    .filter((node) => node.type === "page")
    .sort((left, right) => compareText(left.filePath ?? left.name, right.filePath ?? right.name));
  const pageIds = scope
    ? scopedPageIds(useCases, nodeById, incomingByTarget, outgoingBySource)
    : null;
  const pageCandidates = pageIds
    ? pageNodes.filter((page) => pageIds.has(page.id))
    : pageNodes;
  const truncatedPages = pageCandidates.length > MAX_PAGES;
  const pages = pageCandidates
    .slice(0, MAX_PAGES)
    .map((page) => buildPageSpec(
      page,
      nodeById,
      outgoingBySource,
      incomingByTarget,
      requestHintIndexes,
      tileArrivalOutcomes,
    ));

  const moduleMap = new Map();
  for (const useCase of useCases) {
    const entry = moduleMap.get(useCase.module) ?? { name: useCase.module, useCases: [] };
    entry.useCases.push(useCase);
    moduleMap.set(useCase.module, entry);
  }
  const modules = [...moduleMap.values()].sort((left, right) => compareText(left.name, right.name));

  const nestedTruncation = useCases.some((useCase) => useCase.triggersTruncated
    || useCase.tablesTruncated
    || useCase.flowTruncated)
    || pages.some((page) => page.actionsTruncated || page.arrivalsTruncated);

  return {
    scope,
    modules,
    useCases,
    pages,
    selectionTruncated: truncatedUseCases || truncatedPages,
    detailsTruncated: nestedTruncation,
    truncated: truncatedUseCases || truncatedPages,
    stats: {
      modules: modules.length,
      useCases: useCases.length,
      pages: pages.length,
      routesTotal: allRoutes.length,
      useCaseRoutesTotal: routes.length,
      pagesTotal: pageNodes.length,
    },
  };
}
