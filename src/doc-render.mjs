import { renderInlineText } from "./render.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_MODULE_DIAGRAMS = 30;
const MAX_SEQUENCE_DIAGRAMS = 20;
const MAX_SEQUENCE_PARTICIPANTS = 8;
const MAX_DIAGRAM_EDGES = 120;
const MAX_MERMAID_LABEL_CHARACTERS = 60;
const TRUNCATION_NOTICE = "> 警告：输出已达到安全上限，内容已截断。";
const MODEL_TRUNCATION_NOTICE = "> 说明：条目数量超过生成上限，仅包含排序靠前的部分，其余已截断。";

function createWriter() {
  const chunks = [];
  const suffix = `\n${TRUNCATION_NOTICE}\n`;
  const budget = MAX_DOCUMENT_BYTES - Buffer.byteLength(suffix);
  let bytes = 0;
  let truncated = false;
  let exhausted = false;
  return {
    get exhausted() {
      return exhausted;
    },
    line(value = "") {
      if (exhausted) return false;
      const chunk = `${value}\n`;
      const chunkBytes = Buffer.byteLength(chunk);
      if (bytes + chunkBytes > budget) {
        truncated = true;
        exhausted = true;
        return false;
      }
      chunks.push(chunk);
      bytes += chunkBytes;
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
      return truncated ? `${content}${suffix}` : content;
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
  if (label.length <= MAX_MERMAID_LABEL_CHARACTERS) return label;
  return `${label.slice(0, MAX_MERMAID_LABEL_CHARACTERS - 3)}...`;
}

function citation(evidence) {
  if (!evidence) return "";
  return `${renderInlineText(evidence.file)}:${evidence.line}`;
}

function confidenceNote(useCase) {
  return useCase.minConfidence >= 0.95
    ? `置信度 ${useCase.minConfidence.toFixed(2)}`
    : `置信度 ${useCase.minConfidence.toFixed(2)}（含启发式关系，需人工复核）`;
}

const TRIGGER_LABELS = new Map([
  ["submits_to", "表单提交"],
  ["links_to", "页面链接"],
  ["requests", "脚本请求"],
]);
const ACCESS_LABELS = new Map([
  ["read", "读"],
  ["write", "写"],
  ["read-write", "读写"],
]);
const ARRIVAL_LABELS = new Map([
  ["forwards_to", "转发"],
  ["redirects_to", "重定向"],
  ["includes", "包含"],
  ["uses_tile", "Tiles 组合"],
]);

export function renderUseCases(model) {
  const writer = createWriter();
  writer.lines(
    "# 用例规格（UCS）",
    "",
    `> 由 Legacy Code Atlas 从源码索引自动生成；共 ${model.stats.useCases} 个用例、${model.stats.modules} 个模块。引用为项目相对路径:行号。`,
  );
  if (model.truncated) writer.lines("", MODEL_TRUNCATION_NOTICE);

  for (const module of model.modules) {
    if (writer.exhausted) break;
    writer.lines("", `## 模块 ${renderInlineText(module.name)}`, "");
    for (const useCase of module.useCases) {
      if (writer.exhausted) break;
      const source = citation(useCase.evidence);
      writer.lines(
        `### 用例：${renderInlineText(useCase.route)}`,
        "",
        `- 来源：${source || "无直接证据"}`,
        `- ${confidenceNote(useCase)}`,
      );
      if (useCase.triggers.length > 0) {
        writer.line("- 入口：");
        for (const trigger of useCase.triggers) {
          const kind = TRIGGER_LABELS.get(trigger.kind) ?? trigger.kind;
          const ref = citation(trigger.evidence);
          writer.line(`  - ${kind}，来自页面 ${renderInlineText(trigger.pagePath)}${ref ? `（${ref}）` : ""}`);
        }
      } else {
        writer.line("- 入口：未发现页面入口（可能由外部系统或未解析的动态调用触发）");
      }
      writer.line("- 主流程：");
      for (const step of useCase.mainFlow) {
        const via = step.via ? `（经 ${renderInlineText(step.via)}）` : "";
        const ref = citation(step.evidence);
        writer.line(`  ${step.index}. ${renderInlineText(step.nodeType)} ${renderInlineText(step.name)}${via}${ref ? `，证据 ${ref}` : ""}`);
      }
      if (useCase.flowTruncated) writer.line("  - （主流程超出展示上限，已截断）");
      if (useCase.tables.length > 0) {
        writer.line("- 数据表：");
        for (const table of useCase.tables) {
          writer.line(`  - ${renderInlineText(table.name)}（${ACCESS_LABELS.get(table.access) ?? table.access}）`);
        }
      } else {
        writer.line("- 数据表：未发现直接读写");
      }
      writer.line("");
    }
  }
  return writer.finish();
}

export function renderUiSpec(model) {
  const writer = createWriter();
  writer.lines(
    "# 界面规格（UIS）",
    "",
    `> 由 Legacy Code Atlas 从源码索引自动生成；共 ${model.stats.pages} 个页面。引用为项目相对路径:行号。`,
  );
  if (model.truncated) writer.lines("", MODEL_TRUNCATION_NOTICE);

  for (const page of model.pages) {
    if (writer.exhausted) break;
    writer.lines("", `## 页面 ${renderInlineText(page.filePath)}`, "");
    if (page.visibleText) writer.line(`- 可见文本：${renderInlineText(page.visibleText)}`);
    if (page.fields.length > 0) {
      writer.line(`- 表单字段：${page.fields.map((field) => `\`${renderInlineText(field)}\``).join("、")}`);
    } else {
      writer.line("- 表单字段：无");
    }
    if (page.actions.length > 0) {
      writer.line("- 页面动作：");
      for (const action of page.actions) {
        const kind = TRIGGER_LABELS.get(action.kind) ?? action.kind;
        const ref = citation(action.evidence);
        writer.line(`  - ${kind} -> ${renderInlineText(action.target)}${ref ? `（${ref}）` : ""}`);
      }
    } else {
      writer.line("- 页面动作：无");
    }
    if (page.arrivals.length > 0) {
      writer.line("- 到达方式：");
      for (const arrival of page.arrivals) {
        const kind = ARRIVAL_LABELS.get(arrival.kind) ?? arrival.kind;
        writer.line(`  - ${kind}，来自 ${renderInlineText(arrival.fromType)} ${renderInlineText(arrival.from)}`);
      }
    }
  }
  return writer.finish();
}

function moduleFlowchart(module, writer) {
  const nodeIds = new Map();
  const lines = [];
  const edges = new Set();
  const idFor = (key, label, shapeOpen, shapeClose) => {
    let id = nodeIds.get(key);
    if (!id) {
      id = `n${nodeIds.size}`;
      nodeIds.set(key, id);
      lines.push(`  ${id}${shapeOpen}${mermaidLabel(label)}${shapeClose}`);
    }
    return id;
  };
  for (const useCase of module.useCases) {
    const routeId = idFor(`route:${useCase.route}`, useCase.route, "([", "])");
    for (const trigger of useCase.triggers) {
      const pageId = idFor(`page:${trigger.pagePath}`, trigger.pagePath, "[", "]");
      edges.add(`  ${pageId} -->|${mermaidLabel(trigger.kind)}| ${routeId}`);
    }
    for (const table of useCase.tables) {
      const tableId = idFor(`table:${table.name}`, table.name, "[(", ")]");
      edges.add(`  ${routeId} -->|${mermaidLabel(ACCESS_LABELS.get(table.access) ?? table.access)}| ${tableId}`);
    }
  }
  if (nodeIds.size === 0) return;
  writer.lines("", `## 模块总览：${renderInlineText(module.name)}`, "", "```mermaid", "flowchart LR");
  for (const line of lines) writer.line(line);
  for (const edge of [...edges].sort().slice(0, MAX_DIAGRAM_EDGES)) writer.line(edge);
  writer.lines("```");
}

function sequenceDiagram(useCase, writer) {
  const steps = useCase.mainFlow.slice(0, MAX_SEQUENCE_PARTICIPANTS);
  if (steps.length < 2) return;
  writer.lines("", `## 用例时序：${renderInlineText(useCase.route)}`, "", "```mermaid", "sequenceDiagram");
  steps.forEach((step, index) => {
    writer.line(`  participant P${index} as ${mermaidLabel(`${step.nodeType} ${step.name}`)}`);
  });
  for (let index = 1; index < steps.length; index += 1) {
    writer.line(`  P${index - 1}->>P${index}: ${mermaidLabel(steps[index].via ?? "calls")}`);
  }
  if (useCase.mainFlow.length > steps.length) {
    writer.line(`  Note over P${steps.length - 1}: 后续步骤已截断`);
  }
  writer.lines("```");
}

export function renderDiagrams(model) {
  const writer = createWriter();
  writer.lines(
    "# 系统图（Mermaid）",
    "",
    "> 由 Legacy Code Atlas 从源码索引自动生成；可直接在支持 Mermaid 的 Markdown 查看器中渲染。",
  );
  if (model.truncated) writer.lines("", MODEL_TRUNCATION_NOTICE);

  const modules = model.modules.slice(0, MAX_MODULE_DIAGRAMS);
  if (model.modules.length > modules.length) writer.lines("", MODEL_TRUNCATION_NOTICE);
  for (const module of modules) {
    if (writer.exhausted) break;
    moduleFlowchart(module, writer);
  }

  const sequenced = [...model.useCases]
    .filter((useCase) => useCase.mainFlow.length >= 2)
    .sort((left, right) => right.mainFlow.length - left.mainFlow.length
      || (left.route < right.route ? -1 : left.route > right.route ? 1 : 0))
    .slice(0, MAX_SEQUENCE_DIAGRAMS);
  for (const useCase of sequenced) {
    if (writer.exhausted) break;
    sequenceDiagram(useCase, writer);
  }
  return writer.finish();
}
