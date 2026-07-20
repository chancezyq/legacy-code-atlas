function evidenceRefs(edge) {
  return [...new Set((edge.evidence ?? []).map((entry) => `${entry.file}:${entry.line}`))];
}

function nodeLabel(node) {
  return node ? `${node.type}:${node.name}` : "unknown";
}

export function renderTraceMarkdown(trace, options = {}) {
  const title = options.title ?? `${trace.mode}: ${trace.query}`;
  const nodeById = new Map(trace.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(trace.edges.map((edge) => [edge.id, edge]));
  const lines = [`# ${title}`, ""];

  if (trace.matches.length === 0) {
    lines.push(`未找到与 \`${trace.query}\` 匹配的节点。`, "");
    if (trace.warnings.length) lines.push(...trace.warnings.map((warning) => `- ${warning}`));
    return `${lines.join("\n")}\n`;
  }

  lines.push("## 匹配入口", "");
  for (const match of trace.matches) lines.push(`- ${nodeLabel(match)}（score ${match.score}）`);

  lines.push("", "## 主要链路", "");
  for (const path of trace.paths.slice(0, 12)) {
    const pieces = [];
    for (let index = 0; index < path.nodes.length; index += 1) {
      pieces.push(nodeLabel(nodeById.get(path.nodes[index])));
      if (path.edges[index]) pieces.push(`--${path.edges[index]}-->`);
    }
    lines.push(`- ${pieces.join(" ")}`);
  }

  const proven = trace.edges.filter((edge) => edge.confidence >= 0.95);
  const heuristic = trace.edges.filter((edge) => edge.confidence < 0.95);
  for (const [heading, edges] of [["确定关系", proven], ["启发式关系", heuristic]]) {
    lines.push("", `## ${heading}`, "");
    if (edges.length === 0) {
      lines.push("- 无");
      continue;
    }
    for (const edge of edges) {
      const refs = evidenceRefs(edge);
      lines.push(
        `- ${nodeLabel(nodeById.get(edge.source))} --${edge.type}--> ${nodeLabel(nodeById.get(edge.target))}`
        + `；置信度 ${edge.confidence.toFixed(2)}；${edge.reason || "无说明"}`
        + (refs.length ? `；证据 ${refs.join(", ")}` : ""),
      );
    }
  }

  const unusedEdgeIds = trace.paths.flatMap((path) => path.edgeIds).filter((id) => !edgeById.has(id));
  if (unusedEdgeIds.length) lines.push("", `> 警告：${unusedEdgeIds.length} 条路径边缺失。`);
  if (trace.warnings?.length) {
    lines.push("", "## 未解析与扫描警告", "", ...trace.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}
