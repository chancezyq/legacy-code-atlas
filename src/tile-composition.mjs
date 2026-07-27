function tilePutName(edge) {
  if (typeof edge.data?.name === "string" && edge.data.name) return edge.data.name;
  const reason = typeof edge.reason === "string" ? edge.reason.match(/^Tiles put\s+(.+)$/u) : null;
  return reason?.[1] ?? `edge:${edge.id}`;
}

export function effectiveTilePages(startNodeId, nodeById, outgoingBySource) {
  const pages = [];
  const visitedTiles = new Set();
  const claimedPuts = new Set();
  let templateClaimed = false;

  const edgePath = (path) => {
    const edges = new Array(path?.length ?? 0);
    for (let cursor = path; cursor; cursor = cursor.previous) {
      edges[cursor.length - 1] = cursor.edge;
    }
    return edges;
  };
  const stack = [{ kind: "node", nodeId: startNodeId, path: null }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.kind === "edges") {
      if (frame.index >= frame.steps.length) continue;
      const step = frame.steps[frame.index];
      stack.push({ ...frame, index: frame.index + 1 });
      if (step.putName) {
        if (claimedPuts.has(step.putName)) continue;
        claimedPuts.add(step.putName);
      }
      stack.push({
        kind: "node",
        nodeId: step.edge.target,
        path: {
          previous: frame.path,
          edge: step.edge,
          length: (frame.path?.length ?? 0) + 1,
        },
      });
      continue;
    }

    const node = nodeById.get(frame.nodeId);
    if (!node) continue;
    if (node.type === "page") {
      pages.push({ node, edges: edgePath(frame.path) });
      continue;
    }
    if (node.type !== "tiles_definition" || visitedTiles.has(frame.nodeId)) continue;
    visitedTiles.add(frame.nodeId);

    const outgoing = outgoingBySource.get(frame.nodeId) ?? [];
    const steps = [];
    if (!templateClaimed) {
      const templateEdges = outgoing.filter((edge) => edge.type === "uses_template");
      if (templateEdges.length > 0) {
        templateClaimed = true;
        steps.push(...templateEdges.map((edge) => ({ edge, putName: "" })));
      }
    }
    steps.push(...outgoing
      .filter((edge) => edge.type === "puts")
      .map((edge) => ({ edge, putName: tilePutName(edge) })));
    steps.push(...outgoing
      .filter((edge) => edge.type === "extends_tile")
      .map((edge) => ({ edge, putName: "" })));
    stack.push({ kind: "edges", steps, index: 0, path: frame.path });
  }

  return pages;
}
