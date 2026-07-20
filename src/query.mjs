function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().trim();
}

function searchableValues(node) {
  return [node.name, node.id, node.filePath, ...(node.searchText ?? [])].filter(Boolean).map(normalize);
}

function scoreNode(node, query) {
  const term = normalize(query);
  if (!term) return 0;
  const name = normalize(node.name);
  const id = normalize(node.id);
  if (name === term) return 1000;
  if (id === term || id.endsWith(`:${term}`)) return 950;
  if (name.includes(term)) return 850;
  if (id.includes(term)) return 800;
  let score = 0;
  for (const value of searchableValues(node)) {
    if (value === term) score = Math.max(score, 750);
    else if (value.includes(term)) score = Math.max(score, 650);
    else {
      const tokens = term.split(/\s+/).filter(Boolean);
      if (tokens.length && tokens.every((token) => value.includes(token))) score = Math.max(score, 500);
    }
  }
  return score;
}

export function searchGraph(graph, query, options = {}) {
  const allowedTypes = options.types ? new Set(options.types) : null;
  return graph.nodes
    .filter((node) => !allowedTypes || allowedTypes.has(node.type))
    .map((node) => ({ ...node, score: scoreNode(node, query) }))
    .filter((node) => node.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, "en"))
    .slice(0, options.limit ?? 25);
}

function adjacency(graph, direction, allowedEdgeTypes) {
  const map = new Map();
  const push = (from, to, edge) => {
    const entries = map.get(from) ?? [];
    entries.push({ to, edge });
    map.set(from, entries);
  };
  for (const edge of graph.edges) {
    if (allowedEdgeTypes && !allowedEdgeTypes.has(edge.type)) continue;
    if (direction === "outgoing" || direction === "both") push(edge.source, edge.target, edge);
    if (direction === "incoming" || direction === "both") push(edge.target, edge.source, edge);
  }
  for (const entries of map.values()) entries.sort((left, right) => left.edge.id.localeCompare(right.edge.id, "en"));
  return map;
}

function traverse(graph, startIds, options = {}) {
  const direction = options.direction ?? "outgoing";
  const maxDepth = options.maxDepth ?? 14;
  const maxPaths = options.maxPaths ?? 100;
  const allowedEdgeTypes = options.allowedEdgeTypes ? new Set(options.allowedEdgeTypes) : null;
  const adjacent = adjacency(graph, direction, allowedEdgeTypes);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const visitedNodes = new Set(startIds);
  const visitedEdges = new Set();
  const paths = [];
  const queue = startIds.map((id) => ({ current: id, nodes: [id], edges: [], edgeIds: [] }));

  while (queue.length && paths.length < maxPaths) {
    const path = queue.shift();
    const next = (adjacent.get(path.current) ?? []).filter((entry) => !path.nodes.includes(entry.to));
    const isTerminal = next.length === 0
      || path.edges.length >= maxDepth
      || (direction !== "incoming" && nodeById.get(path.current)?.type === "table");
    if (isTerminal) {
      if (path.nodes.length > 1) paths.push({ nodes: path.nodes, edges: path.edges, edgeIds: path.edgeIds });
      continue;
    }
    for (const entry of next) {
      visitedNodes.add(entry.to);
      visitedEdges.add(entry.edge.id);
      queue.push({
        current: entry.to,
        nodes: [...path.nodes, entry.to],
        edges: [...path.edges, entry.edge.type],
        edgeIds: [...path.edgeIds, entry.edge.id],
      });
    }
  }

  return {
    nodes: graph.nodes.filter((node) => visitedNodes.has(node.id)),
    edges: graph.edges.filter((edge) => visitedEdges.has(edge.id)),
    paths: paths.sort((left, right) => right.nodes.length - left.nodes.length || left.nodes.join().localeCompare(right.nodes.join(), "en")),
  };
}

function mergeTraversals(...traversals) {
  const nodes = new Map();
  const edges = new Map();
  const paths = new Map();
  for (const traversal of traversals) {
    for (const node of traversal.nodes) nodes.set(node.id, node);
    for (const edge of traversal.edges) edges.set(edge.id, edge);
    for (const path of traversal.paths) paths.set(`${path.nodes.join("|")}|${path.edgeIds.join("|")}`, path);
  }
  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id, "en")),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id, "en")),
    paths: [...paths.values()].sort((left, right) => right.nodes.length - left.nodes.length || left.nodes.join().localeCompare(right.nodes.join(), "en")),
  };
}

function trace(graph, query, { mode, types, direction, allowedEdgeTypes }) {
  const matches = searchGraph(graph, query, { types, limit: 10 });
  if (matches.length === 0) return {
    mode,
    query,
    matches: [],
    nodes: [],
    edges: [],
    paths: [],
    warnings: [`未找到：${query}`, ...(graph.warnings ?? [])],
  };
  const topScore = matches[0].score;
  const starts = matches.filter((match) => match.score === topScore).slice(0, 5);
  const startIds = starts.map((node) => node.id);
  const traversal = direction === "split"
    ? mergeTraversals(
      traverse(graph, startIds, { direction: "incoming", allowedEdgeTypes }),
      traverse(graph, startIds, { direction: "outgoing", allowedEdgeTypes }),
    )
    : traverse(graph, startIds, { direction, allowedEdgeTypes });
  return {
    mode,
    query,
    matches: starts,
    ...traversal,
    warnings: [...(graph.warnings ?? [])],
  };
}

export function traceFeature(graph, query) {
  return trace(graph, query, {
    mode: "feature",
    types: ["page", "route", "java_type", "java_method", "statement", "procedure", "tiles_definition", "table"],
    direction: "outgoing",
    allowedEdgeTypes: ["includes", "loads_script", "submits_to", "links_to", "requests", "maps_to", "dispatches_to", "forwards_to", "redirects_to", "uses_tile", "calls", "calls_procedure", "implements", "implemented_by", "uses_statement", "reads_from", "writes_to", "extends", "extends_tile", "uses_template", "puts"],
  });
}

export function traceUrl(graph, url) {
  return trace(graph, url, {
    mode: "url",
    types: ["route"],
    direction: "outgoing",
    allowedEdgeTypes: ["maps_to", "dispatches_to", "forwards_to", "redirects_to", "uses_tile", "calls", "calls_procedure", "implements", "implemented_by", "uses_statement", "reads_from", "writes_to", "extends", "extends_tile", "uses_template", "puts"],
  });
}

export function traceStatement(graph, statementId) {
  return trace(graph, statementId, {
    mode: "statement",
    types: ["statement"],
    direction: "split",
    allowedEdgeTypes: ["submits_to", "links_to", "requests", "maps_to", "dispatches_to", "forwards_to", "redirects_to", "uses_tile", "calls", "calls_procedure", "implements", "implemented_by", "uses_statement", "reads_from", "writes_to", "extends", "extends_tile", "uses_template", "puts"],
  });
}

export function traceProcedure(graph, procedureName) {
  return trace(graph, procedureName, {
    mode: "procedure",
    types: ["procedure"],
    direction: "split",
    allowedEdgeTypes: ["submits_to", "links_to", "requests", "maps_to", "dispatches_to", "calls", "calls_procedure", "implements", "implemented_by", "uses_statement", "reads_from", "writes_to"],
  });
}

export function traceTable(graph, tableName) {
  return trace(graph, tableName, {
    mode: "table",
    types: ["table"],
    direction: "incoming",
    allowedEdgeTypes: ["submits_to", "links_to", "requests", "maps_to", "dispatches_to", "forwards_to", "redirects_to", "uses_tile", "calls", "calls_procedure", "implements", "implemented_by", "uses_statement", "reads_from", "writes_to", "extends", "extends_tile", "uses_template", "puts"],
  });
}
