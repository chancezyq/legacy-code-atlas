import { compareLocale } from "./compare.mjs";
import { webPathForFile } from "./parsers/jsp.mjs";
import { effectiveTilePages } from "./tile-composition.mjs";

// Page arrival contexts: which routes can reach which pages, used to
// attach request contexts to JSP pages. Moved out of the materializer so
// that file can shrink; the only caller is materializeRecords.

export const ARRIVAL_EDGE_TYPES = new Set([
  "forwards_to",
  "redirects_to",
  "uses_tile",
  "includes",
]);

function addPageContext(contextsByPage, pageId, context) {
  const contexts = contextsByPage.get(pageId) ?? new Map();
  const key = `${context.routeUrl}\0${context.topPageId}`;
  if (!contexts.has(key)) contexts.set(key, context);
  contextsByPage.set(pageId, contexts);
}

export function buildOutgoingBySource(graph) {
  const outgoingBySource = new Map();
  for (const edge of [...graph.edges.values()].sort((left, right) => compareLocale(left.id, right.id))) {
    const outgoing = outgoingBySource.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingBySource.set(edge.source, outgoing);
  }
  return outgoingBySource;
}

export function propagateArrivalContexts(graph, seeds, contextsByPage, allowedEdgeTypes = ARRIVAL_EDGE_TYPES, outgoingBySource = null) {
  // Callers that run several propagations over the same graph (see
  // pageArrivalContexts) build this once; rebuilding and re-sorting every
  // edge list per page was the previous O(P x (N+E)) cost.
  const outgoing = outgoingBySource ?? buildOutgoingBySource(graph);
  const queue = [...seeds];
  const visited = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const visitKey = `${current.nodeId}\0${current.routeUrl}\0${current.topPageId}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const node = graph.nodes.get(current.nodeId);
    if (!node) continue;
    const topPageId = node.type === "page" ? current.topPageId || node.id : current.topPageId;
    if (node.type === "page") {
      addPageContext(contextsByPage, node.id, { routeUrl: current.routeUrl, topPageId });
    }
    for (const edge of outgoing.get(node.id) ?? []) {
      if (!allowedEdgeTypes.has(edge.type)) continue;
      const target = graph.nodes.get(edge.target);
      if (!target) continue;
      if (edge.type === "uses_tile" && target.type === "tiles_definition") {
        for (const composition of effectiveTilePages(target.id, graph.nodes, outgoing)) {
          queue.push({
            nodeId: composition.node.id,
            routeUrl: current.routeUrl,
            topPageId,
          });
        }
        continue;
      }
      queue.push({
        nodeId: target.id,
        routeUrl: edge.type === "redirects_to" && target.type === "route"
          ? target.name
          : current.routeUrl,
        topPageId: edge.type === "redirects_to" ? "" : topPageId,
      });
    }
  }
}

export function pageArrivalContexts(graph) {
  const contextsByPage = new Map();
  const outgoing = buildOutgoingBySource(graph);
  const routeSeeds = [...graph.nodes.values()]
    .filter((node) => node.type === "route")
    .sort((left, right) => compareLocale(left.id, right.id))
    .map((route) => ({ nodeId: route.id, routeUrl: route.name, topPageId: "" }));
  propagateArrivalContexts(graph, routeSeeds, contextsByPage, ARRIVAL_EDGE_TYPES, outgoing);

  const pages = [...graph.nodes.values()]
    .filter((node) => node.type === "page")
    .sort((left, right) => compareLocale(left.id, right.id));
  const includedPageIds = new Set(
    [...graph.edges.values()].filter((edge) => edge.type === "includes").map((edge) => edge.target),
  );
  const includesOnly = new Set(["includes"]);
  const fallbackRoots = pages.filter((page) => !contextsByPage.has(page.id) && !includedPageIds.has(page.id));
  propagateArrivalContexts(
    graph,
    fallbackRoots.map((page) => ({
      nodeId: page.id,
      routeUrl: webPathForFile(page.filePath ?? page.name),
      topPageId: page.id,
    })),
    contextsByPage,
    includesOnly,
    outgoing,
  );
  // Previously this loop ran one includes-only BFS per still-uncontextualized
  // page. Those BFS runs are independent: visited keys carry each seed's own
  // routeUrl/topPageId, and contexts are deduplicated by that same key, so
  // batching the remaining seeds into one BFS gives identical contexts.
  const remaining = pages.filter((page) => !contextsByPage.has(page.id));
  if (remaining.length) {
    propagateArrivalContexts(
      graph,
      remaining.map((page) => ({
        nodeId: page.id,
        routeUrl: webPathForFile(page.filePath ?? page.name),
        topPageId: page.id,
      })),
      contextsByPage,
      includesOnly,
      outgoing,
    );
  }
  return new Map([...contextsByPage].map(([pageId, contexts]) => [
    pageId,
    [...contexts.values()].sort((left, right) => compareLocale((
      left.routeUrl, right.routeUrl)
      || compareLocale(left.topPageId, right.topPageId)
    )),
  ]));
}
