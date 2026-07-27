import { createHash } from "node:crypto";

import { renderInlineText } from "./render.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_MODULE_DIAGRAMS = 30;
const MAX_SEQUENCE_DIAGRAMS = 20;
const MAX_SEQUENCE_PARTICIPANTS = 8;
const MAX_DIAGRAM_EDGES = 120;
const MAX_MERMAID_LABEL_CHARACTERS = 60;
const TRUNCATION_NOTICE = "> Warning: output reached the safety limit and was truncated.";
const MODEL_TRUNCATION_NOTICE = "> Note: the number of entries exceeded the generation cap; only the leading entries are included and the rest were truncated.";

function createWriter() {
  const chunks = [];
  const suffix = `\n${TRUNCATION_NOTICE}\n`;
  const closingFence = "```\n";
  const budget = MAX_DOCUMENT_BYTES - Buffer.byteLength(suffix);
  let bytes = 0;
  let truncated = false;
  let exhausted = false;
  let fenceOpen = false;
  return {
    get exhausted() {
      return exhausted;
    },
    line(value = "") {
      if (exhausted) return false;
      const chunk = `${value}\n`;
      const chunkBytes = Buffer.byteLength(chunk);
      const closesFence = fenceOpen && value === "```";
      const opensFence = !fenceOpen && value !== "```" && value.startsWith("```");
      const nextFenceOpen = closesFence ? false : (opensFence || fenceOpen);
      const reservedBytes = nextFenceOpen ? Buffer.byteLength(closingFence) : 0;
      if (bytes + chunkBytes + reservedBytes > budget) {
        truncated = true;
        exhausted = true;
        return false;
      }
      chunks.push(chunk);
      bytes += chunkBytes;
      fenceOpen = nextFenceOpen;
      return true;
    },
    lines(...values) {
      for (const value of values) {
        if (!this.line(value)) return false;
      }
      return true;
    },
    finish() {
      const content = chunks.join("");
      const fenceSuffix = fenceOpen ? closingFence : "";
      return truncated ? `${content}${fenceSuffix}${suffix}` : `${content}${fenceSuffix}`;
    },
  };
}

// Mermaid labels use an allowlist because escaping rules differ between Mermaid
// node shapes; anything outside the list becomes a space so hostile source
// identifiers cannot introduce quotes, fences, brackets, or directives.
function mermaidLabel(value, fallback = "unnamed") {
  const cleaned = String(value ?? "")
    .replace(/[^\p{L}\p{N} _.\-/:#*?]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const label = cleaned || fallback;
  const characters = Array.from(label);
  if (characters.length <= MAX_MERMAID_LABEL_CHARACTERS) return label;
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 8);
  const suffixCharacters = 28;
  const prefixCharacters = MAX_MERMAID_LABEL_CHARACTERS - suffixCharacters - digest.length - 4;
  return `${characters.slice(0, prefixCharacters).join("")}...${characters.slice(-suffixCharacters).join("")}#${digest}`;
}

function citation(evidence) {
  if (!evidence) return "";
  return `${renderInlineText(evidence.file)}:${evidence.line}`;
}

function confidenceNote(confidence, label = "Confidence") {
  return confidence >= 0.95
    ? `${label} ${confidence.toFixed(2)}`
    : `${label} ${confidence.toFixed(2)} (contains heuristic relationships; review manually)`;
}

function flowMinimumConfidence(flow) {
  return flow.reduce(
    (minimum, step) => Math.min(minimum, typeof step.confidence === "number" ? step.confidence : 1),
    1,
  );
}

const TRIGGER_LABELS = new Map([
  ["submits_to", "form submission"],
  ["links_to", "page link"],
  ["requests", "script request"],
]);
const ACCESS_LABELS = new Map([
  ["read", "read"],
  ["write", "write"],
  ["read-write", "read-write"],
]);
const OUTCOME_LABELS = new Map([
  ["forwards_to", "forwards to"],
  ["redirects_to", "redirects to"],
  ["composes", "composes"],
]);
const ARRIVAL_LABELS = new Map([
  ["forwards_to", "forward"],
  ["redirects_to", "redirect"],
  ["includes", "include"],
  ["uses_tile", "Tiles composition"],
  ["puts", "Tiles put"],
  ["uses_template", "Tiles template"],
]);

function outcomeMarker(classification, compact = false) {
  if (classification === "code-confirmed") {
    return compact ? "[code-returned possibility]" : "[code-returned possibility]";
  }
  if (classification === "configured-candidate") {
    return compact
      ? "[configured candidate]"
      : "[configured candidate; not code-confirmed by this index]";
  }
  return "";
}

function outcomeEvidenceText(outcome) {
  const parts = [];
  const configRef = citation(outcome.configEvidence ?? outcome.evidence);
  if (configRef) parts.push(`configuration ${configRef}`);
  const codeRefs = [...new Set((outcome.codeEvidence ?? []).map(citation).filter(Boolean))];
  if (codeRefs.length > 0) parts.push(`code ${codeRefs.join(", ")}`);
  return parts.join("; ");
}

function flowStepText(step) {
  const via = step.via ? ` (via ${renderInlineText(step.via)})` : "";
  const marker = outcomeMarker(step.classification);
  const evidence = marker
    ? outcomeEvidenceText(step)
    : citation(step.evidence);
  const evidenceText = evidence
    ? marker ? `, ${evidence}` : `, evidence ${evidence}`
    : "";
  return `${renderInlineText(step.nodeType)} ${renderInlineText(step.name)}${via}${marker ? ` ${marker}` : ""}${evidenceText}`;
}

function tableCell(value) {
  return renderInlineText(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function crudMatrix(module, writer) {
  const tables = new Map();
  for (const useCase of module.useCases) {
    for (const table of useCase.tables) {
      const row = tables.get(table.name) ?? new Map();
      row.set(useCase.route, table.access);
      tables.set(table.name, row);
    }
  }
  if (tables.size === 0) return;
  writer.lines("", "#### Data access matrix", "", "| Table | Use case | Access |", "| --- | --- | --- |");
  for (const [tableName, row] of [...tables.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    for (const [route, access] of [...row.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      writer.line(`| ${tableCell(tableName)} | ${tableCell(route)} | ${ACCESS_LABELS.get(access) ?? access} |`);
    }
  }
}

function scopeLine(model) {
  if (!model.scope) return null;
  const kind = model.scope.kind === "module" ? "module" : "feature";
  const matched = model.scope.matched ? "" : " — no match; documents are empty";
  return `> Scope: ${kind} \`${renderInlineText(model.scope.query)}\`${matched}`;
}

export function renderUseCases(model) {
  const writer = createWriter();
  writer.lines(
    "# Use Case Specifications (UCS)",
    "",
    `> Generated by Legacy Code Atlas from the source index; ${model.stats.useCases} use cases across ${model.stats.modules} modules. Citations are project-relative path:line.`,
  );
  const scope = scopeLine(model);
  if (scope) writer.line(scope);
  if (model.truncated) writer.lines("", MODEL_TRUNCATION_NOTICE);
  if (model.useCases.length === 0) writer.lines("", "- No use cases were found in the selected index or scope.");

  for (const module of model.modules) {
    if (writer.exhausted) break;
    writer.lines("", `## Module ${renderInlineText(module.name)}`, "");
    for (const useCase of module.useCases) {
      if (writer.exhausted) break;
      const source = citation(useCase.evidence);
      writer.lines(
        `### Use case: ${renderInlineText(useCase.route)}`,
        "",
        `- Source: ${source || "no direct evidence"}`,
        `- ${confidenceNote(useCase.minConfidence, "Main-flow confidence")}`,
      );
      if (useCase.request.methods.length > 0 || useCase.request.hasUnknownMethod) {
        const methods = useCase.request.methods.length === 0
          ? "method unresolved"
          : useCase.request.hasUnknownMethod
            ? `known methods ${useCase.request.methods.join("/")}; other methods unresolved`
            : useCase.request.methods.join("/");
        const parameters = useCase.request.parameters.length > 0
          ? `, parameters ${useCase.request.parameters.map((name) => `\`${renderInlineText(name)}\``).join(", ")}`
          : "";
        const dynamicNames = useCase.request.hasDynamicParameterNames
          ? ", additional parameter names resolved at runtime"
          : "";
        writer.line(`- Request: ${methods}${parameters}${dynamicNames}`);
      }
      if (useCase.triggers.length > 0) {
        writer.line("- Triggers:");
        for (const trigger of useCase.triggers) {
          const kind = TRIGGER_LABELS.get(trigger.kind) ?? trigger.kind;
          const ref = citation(trigger.evidence);
          writer.line(`  - ${kind} from page ${renderInlineText(trigger.pagePath)}${ref ? ` (${ref})` : ""}`);
        }
      } else {
        writer.line("- Triggers: no page entry found (possibly triggered by an external system or an unresolved dynamic call)");
      }
      if (useCase.triggersTruncated) writer.line("  - (additional triggers were truncated)");
      if (useCase.inputs.length > 0) {
        writer.line(`- Inputs: ${useCase.inputs.map((name) => `\`${renderInlineText(name)}\``).join(", ")}`);
      }
      writer.line("- Main flow:");
      for (const step of useCase.mainFlow) {
        writer.line(`  ${step.index}. ${flowStepText(step)}`);
      }
      if (useCase.flowDisplayTruncated
        ?? (useCase.flowTruncated && useCase.flowTraversalTruncated !== true)) {
        writer.line("  - (main flow exceeds the display limit and was truncated)");
      }
      if (useCase.flowTraversalTruncated) {
        writer.line("  - (flow traversal limit reached; additional branches may be omitted)");
      }
      if (useCase.alternateFlows?.length > 0) {
        writer.line("- Additional data flow branches:");
        for (let flowIndex = 0; flowIndex < useCase.alternateFlows.length; flowIndex += 1) {
          const flow = useCase.alternateFlows[flowIndex];
          const confidence = useCase.alternateFlowConfidences?.[flowIndex]
            ?? flowMinimumConfidence(flow);
          writer.line(`  - Branch ${flowIndex + 1}: ${confidenceNote(confidence, "confidence")}`);
          for (const step of flow) {
            writer.line(`    ${step.index}. ${flowStepText(step)}`);
          }
        }
      }
      if (useCase.alternateFlowsTruncated) {
        writer.line("  - (additional data flow branches were truncated)");
      }
      if (useCase.outcomes.length > 0) {
        writer.line("- Outcomes:");
        for (const outcome of useCase.outcomes) {
          const kind = OUTCOME_LABELS.get(outcome.kind) ?? outcome.kind;
          const marker = outcomeMarker(outcome.classification);
          if (marker) {
            const evidence = outcomeEvidenceText(outcome);
            writer.line(`  - ${marker} ${renderInlineText(outcome.reason || "result")}: ${kind} ${renderInlineText(outcome.target)}${evidence ? `; ${evidence}` : ""}`);
          } else {
            const ref = citation(outcome.evidence);
            writer.line(`  - ${renderInlineText(outcome.reason || "result")}: ${kind} ${renderInlineText(outcome.target)}${ref ? ` (${ref})` : ""}`);
          }
        }
      }
      if (useCase.statements.length > 0) {
        writer.line(`- SQL statements: ${useCase.statements.map((statement) => `\`${renderInlineText(statement.id)}\`${statement.operation ? ` (${renderInlineText(statement.operation)})` : ""}`).join(", ")}`);
      }
      if (useCase.tables.length > 0) {
        writer.line("- Tables:");
        for (const table of useCase.tables) {
          writer.line(`  - ${renderInlineText(table.name)} (${ACCESS_LABELS.get(table.access) ?? table.access})`);
        }
      } else {
        writer.line("- Tables: no direct reads or writes found");
      }
      if (useCase.tablesTruncated) writer.line("  - (additional tables were truncated)");
      writer.line("");
    }
    crudMatrix(module, writer);
    writer.line("");
  }
  return writer.finish();
}

export function renderUiSpec(model) {
  const writer = createWriter();
  writer.lines(
    "# UI Specifications (UIS)",
    "",
    `> Generated by Legacy Code Atlas from the source index; ${model.stats.pages} pages. Citations are project-relative path:line.`,
  );
  const scope = scopeLine(model);
  if (scope) writer.line(scope);
  if (model.truncated) writer.lines("", MODEL_TRUNCATION_NOTICE);
  if (model.pages.length === 0) writer.lines("", "- No pages were found in the selected index or scope.");

  for (const page of model.pages) {
    if (writer.exhausted) break;
    writer.lines("", `## Page ${renderInlineText(page.filePath)}`, "");
    if (page.visibleText) writer.line(`- Visible text: ${renderInlineText(page.visibleText)}`);
    if (page.fields.length > 0) {
      writer.lines("- Form fields:", "", "  | Field | Default value |", "  | --- | --- |");
      for (const field of page.fields) {
        writer.line(`  | \`${tableCell(field.name)}\` | ${field.defaultValue ? `\`${tableCell(field.defaultValue)}\`` : ""} |`);
      }
      writer.line("");
    } else {
      writer.line("- Form fields: none");
    }
    if (page.actions.length > 0) {
      writer.line("- Page actions:");
      for (const action of page.actions) {
        const kind = TRIGGER_LABELS.get(action.kind) ?? action.kind;
        const method = action.method ? ` [${renderInlineText(action.method)}]` : "";
        const ref = citation(action.evidence);
        writer.line(`  - ${kind}${method} -> ${renderInlineText(action.target)}${ref ? ` (${ref})` : ""}`);
      }
    } else {
      writer.line("- Page actions: none");
    }
    if (page.actionsTruncated) writer.line("  - (additional page actions were truncated)");
    if (page.arrivals.length > 0) {
      writer.line("- Arrival paths:");
      for (const arrival of page.arrivals) {
        const kind = ARRIVAL_LABELS.get(arrival.kind) ?? arrival.kind;
        const marker = outcomeMarker(arrival.classification);
        if (marker) {
          const evidence = outcomeEvidenceText(arrival);
          writer.line(`  - ${marker} ${kind} from ${renderInlineText(arrival.fromType)} ${renderInlineText(arrival.from)}${evidence ? `; ${evidence}` : ""}`);
        } else {
          const ref = citation(arrival.evidence);
          writer.line(`  - ${kind} from ${renderInlineText(arrival.fromType)} ${renderInlineText(arrival.from)}${ref ? ` (${ref})` : ""}`);
        }
      }
    }
    if (page.arrivalsTruncated) writer.line("  - (additional arrival paths were truncated)");
  }
  return writer.finish();
}

function moduleFlowchart(module, writer) {
  const alternateFlowsTruncated = module.useCases.some(
    (useCase) => useCase.alternateFlowsTruncated === true,
  );
  const nodeIds = new Map();
  const nodeLines = [];
  const edges = new Map();
  const addEdge = (
    source,
    target,
    line,
    heuristic = false,
    candidate = false,
    aggregated = false,
  ) => {
    if (!edges.has(line)) {
      edges.set(line, { source, target, line, heuristic, candidate, aggregated });
    }
  };
  const idFor = (key, label, shapeOpen, shapeClose) => {
    let id = nodeIds.get(key);
    if (!id) {
      id = `n${nodeIds.size}`;
      nodeIds.set(key, id);
      nodeLines.push({ id, line: `  ${id}${shapeOpen}${mermaidLabel(label)}${shapeClose}` });
    }
    return id;
  };
  for (const useCase of module.useCases) {
    const routeId = idFor(useCase.routeId ?? `route:${useCase.route}`, useCase.route, "([", "])");
    for (const trigger of useCase.triggers) {
      const pageId = idFor(`page:${trigger.pagePath}`, trigger.pagePath, "[", "]");
      const heuristic = trigger.confidence < 0.95;
      addEdge(
        pageId,
        routeId,
        `  ${pageId} ${heuristic ? "-.->" : "-->"}|${mermaidLabel(trigger.kind)}| ${routeId}`,
        heuristic,
      );
    }
    const flowTableAccess = new Map();
    const addFlow = (flow) => {
      let previousId = routeId;
      for (let index = 0; index < flow.length; index += 1) {
        const step = flow[index];
        if (index === 0 && step.nodeType === "route") continue;
        let shapeOpen = "[";
        let shapeClose = "]";
        if (step.nodeType === "java_method" || step.nodeType === "java_type") {
          shapeOpen = "[[";
          shapeClose = "]]";
        } else if (step.nodeType === "statement" || step.nodeType === "procedure") {
          shapeOpen = "{{";
          shapeClose = "}}";
        } else if (step.nodeType === "table") {
          shapeOpen = "[(";
          shapeClose = ")]";
          const access = step.via === "reads_from"
            ? "read"
            : step.via === "writes_to"
              ? "write"
              : null;
          if (access) {
            const represented = flowTableAccess.get(step.name) ?? new Set();
            represented.add(access);
            flowTableAccess.set(step.name, represented);
          }
        } else if (step.nodeType === "route") {
          shapeOpen = "([";
          shapeClose = "])";
        }
        const stepId = idFor(
          step.nodeId ?? `${step.nodeType}:${step.name}`,
          step.name,
          shapeOpen,
          shapeClose,
        );
        const heuristic = step.confidence < 0.95;
        const candidate = step.classification === "configured-candidate";
        const marker = outcomeMarker(step.classification, true);
        addEdge(
          previousId,
          stepId,
          `  ${previousId} ${heuristic || candidate ? "-.->" : "-->"}|${mermaidLabel(step.via ?? "flows_to")}${marker ? ` ${marker}` : ""}| ${stepId}`,
          heuristic,
          candidate,
        );
        previousId = stepId;
      }
    };
    addFlow(useCase.mainFlow);
    for (const alternateFlow of useCase.alternateFlows ?? []) addFlow(alternateFlow);
    for (const table of useCase.tables) {
      const represented = flowTableAccess.get(table.name);
      const accessIsRepresented = table.access === "read-write"
        ? represented?.has("read") && represented.has("write")
        : represented?.has(table.access);
      if (accessIsRepresented) continue;
      const tableId = idFor(`table:${table.name}`, table.name, "[(", ")]");
      addEdge(
        routeId,
        tableId,
        `  ${routeId} -.->|${mermaidLabel(`aggregated ${ACCESS_LABELS.get(table.access) ?? table.access}`)}| ${tableId}`,
        false,
        false,
        true,
      );
    }
  }
  if (nodeIds.size === 0) return;
  const sortedEdges = [...edges.values()].sort((left, right) => (
    left.line < right.line ? -1 : left.line > right.line ? 1 : 0
  ));
  const retainedEdges = sortedEdges.slice(0, MAX_DIAGRAM_EDGES);
  const retainedNodeIds = new Set(retainedEdges.flatMap((edge) => [edge.source, edge.target]));
  const renderedNodeLines = retainedEdges.length === 0
    ? nodeLines
    : nodeLines.filter((node) => retainedNodeIds.has(node.id));
  const hasHeuristicEdge = retainedEdges.some((edge) => edge.heuristic);
  const hasCandidateEdge = retainedEdges.some((edge) => edge.candidate);
  const hasAggregatedEdge = retainedEdges.some((edge) => edge.aggregated);
  writer.lines(
    "",
    `## Module overview: ${renderInlineText(module.name)}`,
    "",
    `Legend: rectangles are pages, rounded nodes are routes, double rectangles are Java methods, hexagons are SQL statements or procedures, and cylinders are tables${hasHeuristicEdge ? "; dashed edges are heuristic relationships (confidence below 0.95)" : ""}${hasCandidateEdge ? "; dashed edges include configured-only outcome candidates" : ""}${hasAggregatedEdge ? "; dashed shortcut edges summarize table access omitted from displayed flows" : ""}.`,
    "",
    "```mermaid",
    "flowchart LR",
  );
  for (const node of renderedNodeLines) {
    if (!writer.line(node.line)) break;
  }
  for (const edge of retainedEdges) {
    if (!writer.line(edge.line)) break;
  }
  writer.lines("```");
  if (!writer.exhausted
    && (sortedEdges.length > MAX_DIAGRAM_EDGES || alternateFlowsTruncated)) {
    writer.lines("", MODEL_TRUNCATION_NOTICE);
  }
}

function sequenceDiagram(useCase, writer) {
  const steps = useCase.mainFlow.slice(0, MAX_SEQUENCE_PARTICIPANTS);
  if (steps.length < 2) return;
  writer.lines("", `## Use case sequence: ${renderInlineText(useCase.route)}`, "", "```mermaid", "sequenceDiagram");
  steps.forEach((step, index) => {
    writer.line(`  participant P${index} as ${mermaidLabel(`${step.nodeType} ${step.name}`)}`);
  });
  for (let index = 1; index < steps.length; index += 1) {
    const heuristic = steps[index].confidence < 0.95;
    const candidate = steps[index].classification === "configured-candidate";
    const confirmed = steps[index].classification === "code-confirmed";
    const label = mermaidLabel(steps[index].via ?? "calls");
    const modalities = [];
    if (candidate) modalities.push("configured candidate");
    else if (confirmed) modalities.push("code-returned possibility");
    if (heuristic) modalities.push("heuristic");
    const modality = modalities.length > 0 ? ` (${modalities.join("; ")})` : "";
    writer.line(`  P${index - 1}${heuristic || candidate ? "-->>" : "->>"}P${index}: ${label}${modality}`);
  }
  if (useCase.mainFlow.length > steps.length) {
    writer.line(`  Note over P${steps.length - 1}: remaining steps truncated`);
  }
  writer.lines("```");
}

function navigationDiagram(model, writer) {
  const nodeIds = new Map();
  const nodeLines = [];
  const edges = new Map();
  const addEdge = (source, target, line, heuristic = false, candidate = false) => {
    if (!edges.has(line)) edges.set(line, { source, target, line, heuristic, candidate });
  };
  const idFor = (key, label, shapeOpen = "[", shapeClose = "]") => {
    let id = nodeIds.get(key);
    if (!id) {
      id = `s${nodeIds.size}`;
      nodeIds.set(key, id);
      nodeLines.push({ id, line: `  ${id}${shapeOpen}${mermaidLabel(label)}${shapeClose}` });
    }
    return id;
  };
  for (const page of model.pages ?? []) {
    if (!Array.isArray(page.actions) || page.actions.length === 0) continue;
    const pageKey = page.pageId ?? page.filePath ?? page.name;
    const pageLabel = page.filePath ?? page.name;
    const pageId = idFor(`page:${pageKey}`, pageLabel);
    for (const action of page.actions) {
      const targetKey = action.targetId ?? action.target;
      const targetType = action.targetType ?? "route";
      const targetId = targetType === "route"
        ? idFor(`route:${targetKey}`, action.target, "([", "])")
        : idFor(`${targetType}:${targetKey}`, action.target);
      const heuristic = typeof action.confidence === "number" && action.confidence < 0.95;
      addEdge(
        pageId,
        targetId,
        `  ${pageId} ${heuristic ? "-.->" : "-->"}|${mermaidLabel(action.kind)}| ${targetId}`,
        heuristic,
      );
    }
  }
  for (const useCase of model.useCases) {
    if (useCase.triggers.length === 0 && useCase.outcomes.length === 0) continue;
    const routeId = idFor(`route:${useCase.routeId ?? useCase.route}`, useCase.route, "([", "])");
    for (const trigger of useCase.triggers) {
      const pageKey = trigger.pageId ?? trigger.pagePath ?? trigger.pageName;
      const pageLabel = trigger.pagePath ?? trigger.pageName;
      const heuristic = typeof trigger.confidence === "number" && trigger.confidence < 0.95;
      const pageId = idFor(`page:${pageKey}`, pageLabel);
      addEdge(
        pageId,
        routeId,
        `  ${pageId} ${heuristic ? "-.->" : "-->"}|${mermaidLabel(trigger.kind)}| ${routeId}`,
        heuristic,
      );
    }
    for (const outcome of useCase.outcomes) {
      const pageKey = outcome.targetId ?? outcome.targetPath ?? outcome.target;
      const pageLabel = outcome.targetPath ?? outcome.target;
      const targetType = outcome.targetType ?? (outcome.kind === "redirects_to" ? "route" : "page");
      const targetId = targetType === "route"
        ? idFor(`route:${pageKey}`, pageLabel, "([", "])")
        : idFor(`page:${pageKey}`, pageLabel);
      const heuristic = typeof outcome.confidence === "number" && outcome.confidence < 0.95;
      const candidate = outcome.classification === "configured-candidate";
      const marker = outcomeMarker(outcome.classification, true);
      addEdge(
        routeId,
        targetId,
        `  ${routeId} ${heuristic || candidate ? "-.->" : "-->"}|${mermaidLabel(outcome.reason || outcome.kind)}${marker ? ` ${marker}` : ""}| ${targetId}`,
        heuristic,
        candidate,
      );
    }
  }
  if (edges.size === 0) return;
  const sortedEdges = [...edges.values()].sort((left, right) => (
    left.line < right.line ? -1 : left.line > right.line ? 1 : 0
  ));
  const retainedEdges = sortedEdges.slice(0, MAX_DIAGRAM_EDGES);
  const retainedNodeIds = new Set(retainedEdges.flatMap((edge) => [edge.source, edge.target]));
  const renderedNodeLines = nodeLines.filter((node) => retainedNodeIds.has(node.id));
  const hasHeuristicEdge = retainedEdges.some((edge) => edge.heuristic);
  const hasCandidateEdge = retainedEdges.some((edge) => edge.candidate);
  writer.lines(
    "",
    "## Screen navigation",
    "",
    `Legend: rectangles are pages, rounded nodes are routes; edge labels are the navigation trigger or the forward/redirect/composition result${hasHeuristicEdge ? "; dashed edges are heuristic relationships (confidence below 0.95)" : ""}${hasCandidateEdge ? "; dashed edges include configured-only outcome candidates" : ""}.`,
    "",
    "```mermaid",
    "flowchart LR",
  );
  for (const node of renderedNodeLines) {
    if (!writer.line(node.line)) break;
  }
  for (const edge of retainedEdges) {
    if (!writer.line(edge.line)) break;
  }
  writer.lines("```");
  if (!writer.exhausted && sortedEdges.length > MAX_DIAGRAM_EDGES) {
    writer.lines("", MODEL_TRUNCATION_NOTICE);
  }
}

export function renderDiagrams(model) {
  const writer = createWriter();
  writer.lines(
    "# System Diagrams (Mermaid)",
    "",
    "> Generated by Legacy Code Atlas from the source index; renders directly in Mermaid-capable Markdown viewers.",
  );
  const scope = scopeLine(model);
  if (scope) writer.line(scope);
  if (model.truncated) writer.lines("", MODEL_TRUNCATION_NOTICE);
  if (model.useCases.length === 0) writer.lines("", "- No diagram relationships were found in the selected index or scope.");

  navigationDiagram(model, writer);

  const modules = model.modules.slice(0, MAX_MODULE_DIAGRAMS);
  if (model.modules.length > modules.length) writer.lines("", MODEL_TRUNCATION_NOTICE);
  for (const module of modules) {
    if (writer.exhausted) break;
    moduleFlowchart(module, writer);
  }

  const sequenceCandidates = [...model.useCases]
    .filter((useCase) => useCase.mainFlow.length >= 2)
    .sort((left, right) => right.mainFlow.length - left.mainFlow.length
      || (left.route < right.route ? -1 : left.route > right.route ? 1 : 0));
  const sequenced = sequenceCandidates.slice(0, MAX_SEQUENCE_DIAGRAMS);
  for (const useCase of sequenced) {
    if (writer.exhausted) break;
    sequenceDiagram(useCase, writer);
  }
  if (!writer.exhausted && sequenceCandidates.length > sequenced.length) {
    writer.lines("", MODEL_TRUNCATION_NOTICE);
  }
  return writer.finish();
}
