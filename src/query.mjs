import { compareLocale } from "./compare.mjs";

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().trim();
}

const DEFAULT_MAX_TRAVERSAL_STATES = 5_000;

// Per-graph search index, cached by graph object identity. The graph objects
// passed to search/traverse are the immutable output of materialization
// (graph.toJSON()), so caching normalized values is safe as long as the
// nodes array reference itself has not been replaced. If a caller mutates
// the graph by swapping the nodes array, the cache is rebuilt.
const searchIndexes = new WeakMap();

function searchIndexFor(graph) {
  const cached = searchIndexes.get(graph);
  if (cached && cached.nodes === graph.nodes) return cached;
  const entries = graph.nodes.map((node) => {
    const name = normalize(node.name);
    const id = normalize(node.id);
    const searchText = (node.searchText ?? []).filter(Boolean).map(normalize);
    const values = [node.name, node.id, node.filePath].filter(Boolean).map(normalize).concat(searchText);
    return { node, name, id, searchText, values };
  });
  const index = { nodes: graph.nodes, entries };
  searchIndexes.set(graph, index);
  return index;
}

function scoreEntry(entry, term, tokens) {
  if (!term) return 0;
  if (entry.name === term) return 1000;
  if (entry.id === term || entry.id.endsWith(`:${term}`)) return 950;
  if (entry.name.includes(term)) return 850;
  if (entry.id.includes(term)) return 800;
  let score = 0;
  for (const value of entry.values) {
    if (value === term) score = Math.max(score, 750);
    else if (value.includes(term)) score = Math.max(score, 650);
    else if (tokens.length && tokens.every((token) => value.includes(token))) score = Math.max(score, 500);
  }
  if (tokens.length && tokens.every((token) => entry.searchText.some((value) => value.includes(token)))) {
    score = Math.max(score, 500);
  }
  return score;
}

function compareResults(left, right) {
  return right.score - left.score || compareLocale(left.node.id, right.node.id);
}

// The heap top is the worst entry currently kept: lowest score, and for
// equal scores the largest id (final order prefers the smallest id).
function isWorse(left, right) {
  return left.score < right.score
    || (left.score === right.score &&compareLocale(left.node.id, right.node.id) > 0);
}

function heapPush(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!isWorse(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapReplaceTop(heap, item) {
  heap[0] = item;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && isWorse(heap[left], heap[worst])) worst = left;
    if (right < heap.length && isWorse(heap[right], heap[worst])) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

export function searchGraph(graph, query, options = {}) {
  const allowedTypes = options.types ? new Set(options.types) : null;
  const term = normalize(query);
  const tokens = term.split(/\s+/).filter(Boolean);
  const limit = options.limit ?? 25;
  if (limit === 0) return [];
  const { entries } = searchIndexFor(graph);
  // Top-K selection avoids a full sort of every scored node. The heap keeps
  // only `limit` entries, so repeated searches over a large graph stay
  // O(N log limit) instead of O(N log N), and unscored nodes are never copied.
  if (!Number.isInteger(limit) || limit < 0) {
    return entries
      .filter((entry) => !allowedTypes || allowedTypes.has(entry.node.type))
      .map((entry) => ({ ...entry.node, score: scoreEntry(entry, term, tokens) }))
      .filter((node) => node.score > 0)
      .sort((left, right) => right.score - left.score || compareLocale(left.id, right.id))
      .slice(0, limit);
  }
  const heap = [];
  for (const entry of entries) {
    if (allowedTypes && !allowedTypes.has(entry.node.type)) continue;
    const score = scoreEntry(entry, term, tokens);
    if (score <= 0) continue;
    const result = { node: entry.node, score };
    if (heap.length < limit) {
      heapPush(heap, result);
    } else if (isWorse(heap[0], result)) {
      heapReplaceTop(heap, result);
    }
  }
  return heap
    .sort(compareResults)
    .map(({ node, score }) => ({ ...node, score }));
}

// Adjacency lists are rebuilt only once per graph object, direction and
// edge-type filter. Trace calls (especially split incoming+outgoing traces)
// previously rebuilt and re-sorted the same lists on every traversal.
const adjacencyCaches = new WeakMap();

function cachedAdjacency(graph, direction, allowedEdgeTypes) {
  let perGraph = adjacencyCaches.get(graph);
  if (!perGraph || perGraph.nodes !== graph.nodes || perGraph.edges !== graph.edges) {
    perGraph = {
      nodes: graph.nodes,
      edges: graph.edges,
      nodeById: new Map(graph.nodes.map((node) => [node.id, node])),
      entries: new Map(),
    };
    adjacencyCaches.set(graph, perGraph);
  }
  const key = `${direction}|${allowedEdgeTypes ? [...allowedEdgeTypes].sort().join(",") : ""}`;
  let map = perGraph.entries.get(key);
  if (map) return { map, nodeById: perGraph.nodeById };
  map = new Map();
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
  for (const entries of map.values()) entries.sort((left, right) => compareLocale(left.edge.id, right.edge.id));
  perGraph.entries.set(key, map);
  return { map, nodeById: perGraph.nodeById };
}

function reconstructPath(entry) {
  const nodes = [];
  const edges = [];
  const edgeIds = [];
  for (let current = entry; current; current = current.parent) {
    nodes.push(current.current);
    if (current.edgeType !== undefined) {
      edges.push(current.edgeType);
      edgeIds.push(current.edgeId);
    }
  }
  nodes.reverse();
  edges.reverse();
  edgeIds.reverse();
  return { nodes, edges, edgeIds };
}

function pathIncludes(entry, target) {
  for (let current = entry; current; current = current.parent) {
    if (current.current === target) return true;
  }
  return false;
}

function traverse(graph, startIds, options = {}) {
  const direction = options.direction ?? "outgoing";
  const maxDepth = options.maxDepth ?? 14;
  const maxPaths = options.maxPaths ?? 100;
  const maxStates = options.maxStates ?? DEFAULT_MAX_TRAVERSAL_STATES;
  const allowedEdgeTypes = options.allowedEdgeTypes ? new Set(options.allowedEdgeTypes) : null;
  const { map: adjacent, nodeById } = cachedAdjacency(graph, direction, allowedEdgeTypes);
  const visitedNodes = new Set(startIds);
  const visitedEdges = new Set();
  const paths = [];
  // Queue entries are parent pointers, not copied node/edge arrays: expanding
  // a path is O(1) instead of O(depth), and full arrays are reconstructed
  // only for paths that actually terminate or hit the state limit.
  const queue = startIds.map((id) => ({ current: id, parent: null, depth: 0, nodesLength: 1 }));
  let queueIndex = 0;
  let statesExpanded = 0;
  let statesEnqueued = queue.length;
  let truncated = false;
  let stateLimitReached = false;
  let pathLimitReached = false;
  let depthLimitReached = false;
  let haltedPath = null;

  traversal: while (queueIndex < queue.length && paths.length < maxPaths) {
    if (statesExpanded >= maxStates) {
      truncated = true;
      stateLimitReached = true;
      break;
    }
    const path = queue[queueIndex];
    queue[queueIndex] = null;
    queueIndex += 1;
    statesExpanded += 1;
    const next = (adjacent.get(path.current) ?? []).filter((entry) => !pathIncludes(path, entry.to));
    const depthLimited = next.length > 0 && path.depth >= maxDepth;
    const isTerminal = next.length === 0
      || depthLimited
      || (direction !== "incoming" && nodeById.get(path.current)?.type === "table");
    if (isTerminal) {
      if (depthLimited) {
        truncated = true;
        depthLimitReached = true;
      }
      if (path.nodesLength > 1) {
        paths.push({
          ...reconstructPath(path),
          ...(depthLimited ? { truncated: true } : {}),
        });
      }
      continue;
    }
    for (const entry of next) {
      if (statesEnqueued >= maxStates) {
        truncated = true;
        stateLimitReached = true;
        haltedPath = path;
        break traversal;
      }
      visitedNodes.add(entry.to);
      visitedEdges.add(entry.edge.id);
      queue.push({
        current: entry.to,
        parent: path,
        edgeType: entry.edge.type,
        edgeId: entry.edge.id,
        depth: path.depth + 1,
        nodesLength: path.nodesLength + 1,
      });
      statesEnqueued += 1;
    }
  }

  if (paths.length >= maxPaths && queueIndex < queue.length) {
    truncated = true;
    pathLimitReached = true;
  }
  if (stateLimitReached && paths.length < maxPaths) {
    const frontier = [haltedPath, ...queue.slice(queueIndex)]
      .filter((path) => path?.nodesLength > 1)
      .map((path) => reconstructPath(path))
      .sort((left, right) => right.nodes.length - left.nodes.length
        || compareLocale(left.nodes.join(), right.nodes.join()));
    const seen = new Set(paths.map((path) => `${path.nodes.join("|")}|${path.edgeIds.join("|")}`));
    for (const path of frontier) {
      const key = `${path.nodes.join("|")}|${path.edgeIds.join("|")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (paths.length < maxPaths) {
        paths.push({ nodes: path.nodes, edges: path.edges, edgeIds: path.edgeIds, truncated: true });
        continue;
      }
      pathLimitReached = true;
      break;
    }
  }

  return {
    nodes: graph.nodes.filter((node) => visitedNodes.has(node.id)),
    edges: graph.edges.filter((edge) => visitedEdges.has(edge.id)),
    paths: paths.sort((left, right) => right.nodes.length - left.nodes.length || compareLocale(left.nodes.join(), right.nodes.join())),
    truncated,
    stateLimit: maxStates,
    pathLimit: maxPaths,
    depthLimit: maxDepth,
    stateLimitReached,
    pathLimitReached,
    depthLimitReached,
    statesExpanded,
    statesEnqueued,
  };
}

export function traverseGraph(graph, startIds, options = {}) {
  return traverse(graph, startIds, options);
}

function mergeTraversals(...traversals) {
  const nodes = new Map();
  const edges = new Map();
  const paths = new Map();
  let truncated = false;
  let stateLimit = 0;
  let pathLimit = 0;
  let stateLimitReached = false;
  let pathLimitReached = false;
  let depthLimitReached = false;
  let depthLimit = 0;
  let statesExpanded = 0;
  let statesEnqueued = 0;
  for (const traversal of traversals) {
    for (const node of traversal.nodes) nodes.set(node.id, node);
    for (const edge of traversal.edges) edges.set(edge.id, edge);
    for (const path of traversal.paths) paths.set(`${path.nodes.join("|")}|${path.edgeIds.join("|")}`, path);
    truncated ||= traversal.truncated;
    stateLimit = Math.max(stateLimit, traversal.stateLimit);
    pathLimit = Math.max(pathLimit, traversal.pathLimit);
    depthLimit = Math.max(depthLimit, traversal.depthLimit);
    stateLimitReached ||= traversal.stateLimitReached;
    pathLimitReached ||= traversal.pathLimitReached;
    depthLimitReached ||= traversal.depthLimitReached;
    statesExpanded += traversal.statesExpanded;
    statesEnqueued += traversal.statesEnqueued;
  }
  return {
    nodes: [...nodes.values()].sort((left, right) => compareLocale(left.id, right.id)),
    edges: [...edges.values()].sort((left, right) => compareLocale(left.id, right.id)),
    paths: [...paths.values()].sort((left, right) => right.nodes.length - left.nodes.length || compareLocale(left.nodes.join(), right.nodes.join())),
    truncated,
    stateLimit,
    pathLimit,
    depthLimit,
    stateLimitReached,
    pathLimitReached,
    depthLimitReached,
    statesExpanded,
    statesEnqueued,
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
    truncated: false,
    stateLimit: 0,
    pathLimit: 0,
    depthLimit: 0,
    stateLimitReached: false,
    pathLimitReached: false,
    depthLimitReached: false,
    statesExpanded: 0,
    statesEnqueued: 0,
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
    warnings: [
      ...(traversal.stateLimitReached
        ? [direction === "split"
            ? `追踪在至少一个方向达到每个方向 ${traversal.stateLimit} 个状态的安全上限，结果已截断。`
            : `追踪达到 ${traversal.stateLimit} 个状态的安全上限，结果已截断。`]
        : []),
      ...(traversal.pathLimitReached
        ? [direction === "split"
            ? `追踪在至少一个方向达到每个方向 ${traversal.pathLimit} 条路径的结果上限，结果已截断。`
            : `追踪达到 ${traversal.pathLimit} 条路径的结果上限，结果已截断。`]
        : []),
      ...(traversal.depthLimitReached
        ? [direction === "split"
            ? `追踪在至少一个方向达到每个方向 ${traversal.depthLimit} 层的深度上限，结果已截断。`
            : `追踪达到 ${traversal.depthLimit} 层的深度上限，结果已截断。`]
        : []),
      ...(graph.warnings ?? []),
    ],
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
