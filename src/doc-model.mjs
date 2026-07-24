import { searchGraph, traverseGraph } from "./query.mjs";

const MAX_USE_CASES = 200;
const MAX_PAGES = 200;
const MAX_TRIGGERS_PER_USE_CASE = 20;
const MAX_FLOW_STEPS = 24;
const MAX_ACTIONS_PER_PAGE = 40;
const MAX_ARRIVALS_PER_PAGE = 20;
const MAX_TABLES_PER_USE_CASE = 20;
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
const PAGE_ACTION_EDGE_TYPES = new Set(["submits_to", "links_to", "requests"]);
const PAGE_ARRIVAL_EDGE_TYPES = new Set(["forwards_to", "redirects_to", "includes", "uses_tile"]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function firstEvidence(entry) {
  const evidence = Array.isArray(entry?.evidence) ? entry.evidence[0] : null;
  if (!evidence || typeof evidence.file !== "string" || !Number.isInteger(evidence.line)) return null;
  return { file: evidence.file, line: evidence.line };
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

function buildUseCase(graph, route, nodeById, incomingByTarget) {
  const triggers = [];
  for (const edge of incomingByTarget.get(route.id) ?? []) {
    if (!TRIGGER_EDGE_TYPES.has(edge.type)) continue;
    const source = nodeById.get(edge.source);
    if (!source || source.type !== "page") continue;
    triggers.push({
      kind: edge.type,
      pagePath: source.filePath ?? source.name,
      pageName: source.name,
      evidence: firstEvidence(edge),
    });
  }
  triggers.sort((left, right) => compareText(left.pagePath, right.pagePath) || compareText(left.kind, right.kind));

  const traversal = traverseGraph(graph, [route.id], {
    direction: "outgoing",
    allowedEdgeTypes: FLOW_EDGE_TYPES,
  });
  const edgeById = new Map(traversal.edges.map((edge) => [edge.id, edge]));
  const mainPath = traversal.paths[0] ?? { nodes: [route.id], edges: [], edgeIds: [] };

  let minConfidence = 1;
  const mainFlow = [];
  const flowNodeIds = mainPath.nodes.slice(0, MAX_FLOW_STEPS);
  for (let index = 0; index < flowNodeIds.length; index += 1) {
    const node = nodeById.get(flowNodeIds[index]);
    const viaEdge = index > 0 ? edgeById.get(mainPath.edgeIds[index - 1]) : null;
    if (viaEdge && typeof viaEdge.confidence === "number") {
      minConfidence = Math.min(minConfidence, viaEdge.confidence);
    }
    mainFlow.push({
      index: index + 1,
      nodeId: flowNodeIds[index],
      nodeType: node?.type ?? "unknown",
      name: node?.name ?? flowNodeIds[index],
      via: viaEdge?.type ?? null,
      evidence: firstEvidence(viaEdge) ?? firstEvidence(node),
    });
  }

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
  const tables = [...tableAccess.entries()]
    .map(([name, entry]) => ({ name, access: accessLabel(entry.reads, entry.writes) }))
    .sort((left, right) => compareText(left.name, right.name))
    .slice(0, MAX_TABLES_PER_USE_CASE);

  return {
    route: route.name,
    routeId: route.id,
    module: moduleNameForRoute(route.name),
    evidence: firstEvidence(route),
    triggers: triggers.slice(0, MAX_TRIGGERS_PER_USE_CASE),
    mainFlow,
    flowTruncated: traversal.truncated || mainPath.nodes.length > MAX_FLOW_STEPS,
    tables,
    minConfidence,
  };
}

function buildPageSpec(page, nodeById, outgoingBySource, incomingByTarget) {
  const actions = [];
  for (const edge of outgoingBySource.get(page.id) ?? []) {
    if (!PAGE_ACTION_EDGE_TYPES.has(edge.type)) continue;
    const target = nodeById.get(edge.target);
    if (!target) continue;
    actions.push({
      kind: edge.type,
      target: target.name,
      evidence: firstEvidence(edge),
    });
  }
  actions.sort((left, right) => compareText(left.target, right.target) || compareText(left.kind, right.kind));

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
    });
  }
  arrivals.sort((left, right) => compareText(left.from, right.from) || compareText(left.kind, right.kind));

  return {
    filePath: page.filePath ?? page.name,
    name: page.name,
    visibleText: String(page.data?.visibleText ?? ""),
    fields: Array.isArray(page.data?.fields) ? page.data.fields.map(String) : [],
    actions: actions.slice(0, MAX_ACTIONS_PER_PAGE),
    arrivals: arrivals.slice(0, MAX_ARRIVALS_PER_PAGE),
  };
}

const MAX_SCOPE_SLUG_CHARACTERS = 48;
const MAX_SCOPE_SEARCH_MATCHES = 500;

export function scopeSlug(query) {
  const slug = String(query ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SCOPE_SLUG_CHARACTERS)
    .replace(/^-+|-+$/gu, "");
  return slug || "scope";
}

function resolveScope(query, useCases) {
  const normalized = String(query).normalize("NFKC").toLowerCase().trim();
  const moduleNames = new Set(useCases.map((useCase) => useCase.module.toLowerCase()));
  if (moduleNames.has(normalized)) {
    return { kind: "module", query: String(query).trim(), matched: true, slug: scopeSlug(query) };
  }
  return { kind: "feature", query: String(query).trim(), matched: false, slug: scopeSlug(query) };
}

function applyScope(scope, graph, useCases, pages) {
  let keptUseCases;
  if (scope.kind === "module") {
    const wanted = scope.query.toLowerCase();
    keptUseCases = useCases.filter((useCase) => useCase.module.toLowerCase() === wanted);
  } else {
    const matches = new Set(
      searchGraph(graph, scope.query, { limit: MAX_SCOPE_SEARCH_MATCHES }).map((node) => node.id),
    );
    keptUseCases = useCases.filter((useCase) => (
      matches.has(useCase.routeId) || useCase.mainFlow.some((step) => matches.has(step.nodeId))
    ));
    scope.matched = keptUseCases.length > 0;
  }

  const keptRoutes = new Set(keptUseCases.map((useCase) => useCase.route));
  const keptPagePaths = new Set(
    keptUseCases.flatMap((useCase) => useCase.triggers.map((trigger) => trigger.pagePath)),
  );
  const keptPages = pages.filter((page) => (
    keptPagePaths.has(page.filePath)
    || page.actions.some((action) => keptRoutes.has(action.target))
    || page.arrivals.some((arrival) => keptRoutes.has(arrival.from))
  ));
  return { keptUseCases, keptPages };
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
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  for (const edge of [...graph.edges].sort((left, right) => compareText(left.id, right.id))) {
    const incoming = incomingByTarget.get(edge.target) ?? [];
    incoming.push(edge);
    incomingByTarget.set(edge.target, incoming);
    const outgoing = outgoingBySource.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingBySource.set(edge.source, outgoing);
  }

  const routes = graph.nodes
    .filter((node) => node.type === "route")
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
  const truncatedUseCases = routes.length > MAX_USE_CASES;
  let useCases = routes
    .slice(0, MAX_USE_CASES)
    .map((route) => buildUseCase(graph, route, nodeById, incomingByTarget));

  const pageNodes = graph.nodes
    .filter((node) => node.type === "page")
    .sort((left, right) => compareText(left.filePath ?? left.name, right.filePath ?? right.name));
  const truncatedPages = pageNodes.length > MAX_PAGES;
  let pages = pageNodes
    .slice(0, MAX_PAGES)
    .map((page) => buildPageSpec(page, nodeById, outgoingBySource, incomingByTarget));

  let scope = null;
  if (options.scopeQuery !== undefined) {
    scope = resolveScope(options.scopeQuery, useCases);
    const { keptUseCases, keptPages } = applyScope(scope, graph, useCases, pages);
    useCases = keptUseCases;
    pages = keptPages;
  }

  const moduleMap = new Map();
  for (const useCase of useCases) {
    const entry = moduleMap.get(useCase.module) ?? { name: useCase.module, useCases: [] };
    entry.useCases.push(useCase);
    moduleMap.set(useCase.module, entry);
  }
  const modules = [...moduleMap.values()].sort((left, right) => compareText(left.name, right.name));

  return {
    scope,
    modules,
    useCases,
    pages,
    truncated: truncatedUseCases || truncatedPages,
    stats: {
      modules: modules.length,
      useCases: useCases.length,
      pages: pages.length,
      routesTotal: routes.length,
      pagesTotal: pageNodes.length,
    },
  };
}
