import { normalizePath } from "./evidence.mjs";

const nodeStates = new WeakMap();
const observableByTarget = new WeakMap();
const observableByProxy = new WeakMap();
const dataItemOrigins = new WeakMap();

function normalizeKey(key) {
  return normalizePath(String(key).trim());
}

function normalizeEvidence(evidence = []) {
  return evidence.map((entry) => {
    const snapshot = cloneValue(entry);
    return { ...snapshot, file: normalizePath(snapshot.file) };
  });
}

function isWeakMapKey(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function observable(value, listener) {
  if (value === null || typeof value !== "object") return value;
  const existing = observableByProxy.get(value) ?? observableByTarget.get(value);
  if (existing) {
    existing.listeners.add(listener);
    return existing.proxy;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value;

  const metadata = { target: value, listeners: new Set([listener]), proxy: null };
  const notify = () => {
    for (const currentListener of metadata.listeners) currentListener();
  };
  const proxy = new Proxy(value, {
    get(target, property) {
      const current = Reflect.get(target, property, target);
      if (current === null || typeof current !== "object") return current;
      let observed = current;
      for (const currentListener of metadata.listeners) observed = observable(observed, currentListener);
      return observed;
    },
    set(target, property, next) {
      const updated = Reflect.set(target, property, next, target);
      if (updated) notify();
      return updated;
    },
    deleteProperty(target, property) {
      const deleted = Reflect.deleteProperty(target, property);
      if (deleted) notify();
      return deleted;
    },
    defineProperty(target, property, descriptor) {
      const defined = Reflect.defineProperty(target, property, descriptor);
      if (defined) notify();
      return defined;
    },
  });
  metadata.proxy = proxy;
  observableByTarget.set(value, metadata);
  observableByProxy.set(proxy, metadata);
  return proxy;
}

function cloneValue(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  const target = observableByProxy.get(value)?.target ?? value;
  if (seen.has(target)) return seen.get(target);
  const clone = Array.isArray(target) ? new Array(target.length) : {};
  seen.set(target, clone);
  for (const key of Object.keys(target)) clone[key] = cloneValue(target[key], seen);
  return clone;
}

function createNodeState(node) {
  const state = {
    evidenceArray: null,
    evidenceIndex: null,
    evidenceLength: 0,
    evidenceDirty: false,
    searchTextArray: null,
    searchTextIndex: new Map(),
    searchTextLength: 0,
    searchTextDirty: false,
    dataItemKeys: new Map(),
  };
  state.markEvidenceDirty = () => { state.evidenceDirty = true; };
  state.markSearchTextDirty = () => { state.searchTextDirty = true; };
  node.evidence = observable(node.evidence, state.markEvidenceDirty);
  node.searchText = observable(node.searchText, state.markSearchTextDirty);
  state.evidenceArray = node.evidence;
  state.evidenceLength = node.evidence.length;
  state.searchTextArray = node.searchText;
  state.searchTextLength = node.searchText.length;
  node.searchText.forEach((value, index) => state.searchTextIndex.set(value, { value, index }));
  return state;
}

function stateForNode(node) {
  const current = nodeStates.get(node);
  if (current) return current;
  const state = createNodeState(node);
  nodeStates.set(node, state);
  return state;
}

function rebuildEvidenceIndex(node, state) {
  const index = new Map();
  const unique = [];
  for (const entry of node.evidence) {
    const key = JSON.stringify(entry);
    if (index.has(key)) continue;
    const indexed = { item: entry, index: unique.length };
    index.set(key, indexed);
    unique.push(entry);
  }
  node.evidence = observable(unique, state.markEvidenceDirty);
  state.evidenceArray = node.evidence;
  state.evidenceIndex = index;
  state.evidenceLength = node.evidence.length;
  state.evidenceDirty = false;
}

function rebuildSearchTextIndex(node, state) {
  const index = new Map();
  const unique = [];
  node.searchText.forEach((value) => {
    if (index.has(value)) return;
    index.set(value, { value, index: unique.length });
    unique.push(value);
  });
  node.searchText = observable(unique, state.markSearchTextDirty);
  state.searchTextArray = node.searchText;
  state.searchTextIndex = index;
  state.searchTextLength = node.searchText.length;
  state.searchTextDirty = false;
}

function evidenceIndexFor(node, state) {
  if (state.evidenceIndex === null
    || state.evidenceDirty
    || state.evidenceArray !== node.evidence
    || state.evidenceLength !== node.evidence.length) {
    rebuildEvidenceIndex(node, state);
  }
  return state.evidenceIndex;
}

function searchTextIndexFor(node, state) {
  if (state.searchTextDirty
    || state.searchTextArray !== node.searchText
    || state.searchTextLength !== node.searchText.length) {
    rebuildSearchTextIndex(node, state);
  }
  return state.searchTextIndex;
}

function countBy(items, field) {
  const counts = {};
  for (const item of items) counts[item[field]] = (counts[item[field]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, "en")));
}

export class GraphBuilder {
  constructor({ projectRoot, warnings = [] }) {
    this.projectRoot = projectRoot;
    this.warnings = [...warnings];
    this.nodes = new Map();
    this.edges = new Map();
  }

  addWarning(warning) {
    this.warnings.push(String(warning));
  }

  addNode({ type, key, name, filePath, evidence = [], data = {}, searchText = [] }) {
    if (!type || key === undefined || key === null) throw new TypeError("node type and key are required");
    const normalizedKey = normalizeKey(key);
    const id = `${type}:${normalizedKey}`;
    const normalizedEvidence = normalizeEvidence(evidence);
    const searchTextKeys = new Set(searchText.map(String));
    const incoming = {
      id,
      type,
      name: String(name ?? normalizedKey),
      ...(filePath ? { filePath: normalizePath(filePath) } : {}),
      evidence: normalizedEvidence,
      data,
      searchText: [...searchTextKeys],
    };
    const existing = this.nodes.get(id);
    if (!existing) {
      this.nodes.set(id, incoming);
      nodeStates.set(incoming, createNodeState(incoming));
      return incoming;
    }

    const state = stateForNode(existing);
    let evidenceIndex = evidenceIndexFor(existing, state);
    for (const incomingEvidence of incoming.evidence) {
      const evidenceKey = JSON.stringify(incomingEvidence);
      let existingEvidence = evidenceIndex.get(evidenceKey);
      if (existingEvidence
        && (existing.evidence[existingEvidence.index] !== existingEvidence.item
          || JSON.stringify(existingEvidence.item) !== evidenceKey)) {
        rebuildEvidenceIndex(existing, state);
        evidenceIndex = state.evidenceIndex;
        existingEvidence = evidenceIndex.get(evidenceKey);
      }
      if (existingEvidence) continue;
      const index = existing.evidence.length;
      const item = observable(incomingEvidence, state.markEvidenceDirty);
      existing.evidence.push(item);
      const entry = { item, index };
      evidenceIndex.set(evidenceKey, entry);
    }
    state.evidenceArray = existing.evidence;
    state.evidenceLength = existing.evidence.length;
    state.evidenceDirty = false;
    let searchTextIndex = searchTextIndexFor(existing, state);
    for (const text of incoming.searchText) {
      const existingText = searchTextIndex.get(text);
      if (existingText && existing.searchText[existingText.index] !== existingText.value) {
        rebuildSearchTextIndex(existing, state);
        searchTextIndex = state.searchTextIndex;
      }
      if (searchTextIndex.has(text)) continue;
      const index = existing.searchText.length;
      existing.searchText.push(text);
      searchTextIndex.set(text, { value: text, index });
    }
    state.searchTextArray = existing.searchText;
    state.searchTextLength = existing.searchText.length;
    state.searchTextDirty = false;
    existing.data = { ...existing.data, ...incoming.data };
    if (!existing.filePath && incoming.filePath) existing.filePath = incoming.filePath;
    return existing;
  }

  addNodeDataItem(nodeOrId, field, item) {
    const id = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id;
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node: ${String(id)}`);
    if (typeof field !== "string" || !field) throw new TypeError("node data field is required");
    let current = node.data[field] ?? [];
    if (!Array.isArray(current)) throw new TypeError(`node data field must be an array: ${field}`);

    const state = stateForNode(node);
    let itemState = state.dataItemKeys.get(field);
    const rebuildItemState = (existingState) => {
      const rebuilt = existingState ?? {
        array: null,
        length: 0,
        dirty: false,
        keys: new Set(),
        itemsByKey: new Map(),
      };
      rebuilt.keys = new Set();
      rebuilt.itemsByKey = new Map();
      rebuilt.markDirty ??= () => { rebuilt.dirty = true; };
      const unique = [];
      for (const existing of current) {
        const original = dataItemOrigins.get(existing) ?? existing;
        const observed = observable(
          observableByProxy.has(existing) ? existing : cloneValue(existing),
          rebuilt.markDirty,
        );
        const key = JSON.stringify(observed);
        if (rebuilt.keys.has(key)) continue;
        rebuilt.keys.add(key);
        const entry = {
          item: observed,
          index: unique.length,
          original,
        };
        if (isWeakMapKey(observed)) dataItemOrigins.set(observed, original);
        rebuilt.itemsByKey.set(key, entry);
        unique.push(observed);
      }
      current = observable(unique, rebuilt.markDirty);
      rebuilt.array = current;
      rebuilt.length = current.length;
      rebuilt.dirty = false;
      node.data[field] = current;
      state.dataItemKeys.set(field, rebuilt);
      return rebuilt;
    };
    if (!itemState || itemState.array !== current || itemState.length !== current.length || itemState.dirty) {
      itemState = rebuildItemState(itemState?.array === current ? itemState : undefined);
    }

    current = itemState.array;
    const stored = observable(cloneValue(item), itemState.markDirty);
    const key = JSON.stringify(stored);
    let existing = itemState.itemsByKey.get(key);
    if (existing
      && (current[existing.index] !== existing.item || JSON.stringify(existing.item) !== key)) {
      itemState = rebuildItemState(itemState);
      current = itemState.array;
      existing = itemState.itemsByKey.get(key);
    }
    if (existing) return existing.original;
    itemState.keys.add(key);
    if (isWeakMapKey(stored)) dataItemOrigins.set(stored, item);
    const entry = { item: stored, index: current.length, original: item };
    itemState.itemsByKey.set(key, entry);
    current.push(stored);
    itemState.length = current.length;
    itemState.dirty = false;
    node.data[field] = current;
    return item;
  }

  addEdge({ source, target, type, confidence, reason = "", evidence = [], data = {} }) {
    if (!this.nodes.has(source)) throw new Error(`unknown source node: ${source}`);
    if (!this.nodes.has(target)) throw new Error(`unknown target node: ${target}`);
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      throw new TypeError("edge confidence must be between 0 and 1");
    }
    const id = `${source}|${type}|${target}|${reason}`;
    const edge = {
      id,
      source,
      target,
      type,
      confidence,
      reason,
      evidence: normalizeEvidence(evidence),
      data,
    };
    if (!this.edges.has(id)) this.edges.set(id, edge);
    return this.edges.get(id);
  }

  toJSON() {
    const nodes = [...this.nodes.values()]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((node) => cloneValue(node));
    const edges = [...this.edges.values()]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((edge) => cloneValue(edge));
    return {
      schemaVersion: "1.0.0",
      project: { root: this.projectRoot },
      summary: {
        nodes: nodes.length,
        edges: edges.length,
        nodeTypes: countBy(nodes, "type"),
        edgeTypes: countBy(edges, "type"),
      },
      nodes,
      edges,
      warnings: [...new Set(this.warnings)].sort((left, right) => left.localeCompare(right, "en")),
    };
  }
}

export function serializeGraph(graph) {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
