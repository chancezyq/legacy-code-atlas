# Share-Docs Generation Design (v0.2.0)

**Goal:** Generate shareable user-guidance documents from the analyzed graph index — use case specifications (UCS), UI specifications (UIS), and Mermaid diagrams — so a team can hand new users and maintainers documents that describe what the legacy system does, without reading source code.

**Decision context:** Designed autonomously under a /goal directive. Decisions below follow the repository's established constraints: evidence-first output, deterministic rendering, bounded output sizes, no absolute paths in artifacts, Skill-only OpenCode integration with fixed commands, and Chinese-first user-facing text.

## What gets generated

One CLI command writes three Markdown files into the analyzed project:

```
.legacy-code-atlas/docs/use-cases.md   # UCS：按模块分组的用例规格
.legacy-code-atlas/docs/ui-spec.md     # UIS：每个 JSP 页面的界面规格
.legacy-code-atlas/docs/diagrams.md    # Mermaid：模块总览图 + 用例时序图
```

The files live under `.legacy-code-atlas/` like `index.json`, are project-relative-cited only, and are safe to copy into a wiki or send to colleagues. GitHub/GitLab render the Mermaid blocks natively.

### use-cases.md (UCS)

Grouped by module (first URL path segment, e.g. `/order/*` → 模块 `order`). Each route node becomes one use case with:

- **入口（triggers）:** incoming `submits_to` (表单提交), `links_to` (页面链接), `requests` (脚本请求) edges from pages, with evidence `file:line` citations and the page's visible text as context.
- **主流程（main flow）:** the longest traversal path from the route through `maps_to`/`dispatches_to`/`calls`/`uses_statement`/… to a terminal node, rendered as a numbered step list (节点类型 + 名称 + 证据).
- **数据（data touched）:** tables reached via `reads_from` (读) / `writes_to` (写) during traversal.
- **可信度:** the minimum edge confidence on the main flow; below 0.95 the use case is marked 启发式，需人工复核 per the repository's evidence policy.

### ui-spec.md (UIS)

One section per `page` node:

- **页面标题/可见文本:** from `data.visibleText`.
- **表单字段:** from `data.fields`.
- **页面动作:** outgoing `submits_to`/`links_to`/`requests` edges with target URL and evidence.
- **到达方式:** incoming `forwards_to`/`redirects_to`/`includes`/`uses_tile` edges (which actions/pages lead here).

### diagrams.md (Mermaid)

- **模块总览 flowchart:** one `flowchart LR` per module — pages → routes → Java types → tables, condensed (deduplicated node boxes, capped).
- **用例时序图:** `sequenceDiagram` for the top use cases (by flow length), participants derived from the main flow chain.
- All Mermaid labels sanitized: control characters replaced (existing `replaceUnsafeTextControls`), quotes/brackets/backticks escaped so hostile source identifiers cannot break out of a label or inject Mermaid directives.

## Architecture

Two new pure modules plus CLI wiring; traversal is reused, not reimplemented:

```
graph (validated 1.0.0 index)
  → src/doc-model.mjs  buildDocumentModel(graph)         # pure derivation, no I/O
  → src/doc-render.mjs renderUseCases/renderUiSpec/renderDiagrams(model)  # pure, bounded
  → bin docs command   loadGraph → model → 3 × writeFileAtomic
```

- **`src/doc-model.mjs`** — `buildDocumentModel(graph, options)` returns `{ modules, useCases, pages, stats }`. Modules/use cases/pages are sorted deterministically (locale-independent compare, same as graph serialization). Traversal reuses `traverseGraph` — the existing private `traverse` in `src/query.mjs` gets exported under that name so the documented 5,000-state / 100-path caps and truncation warnings apply unchanged.
- **`src/doc-render.mjs`** — three renderers producing Markdown strings. Same writer pattern as `render.mjs`: per-file byte cap (1 MiB) with an explicit truncation notice, entry caps (≤200 use cases, ≤200 pages, ≤30 module diagrams, ≤20 sequence diagrams, ≤24 steps per flow), `renderInlineText`-style escaping for Markdown and a Mermaid-specific label escaper.
- **CLI** — `legacy-code-atlas docs <project> [--json]`. Uses the existing `loadGraph` (analyzes first when no index exists, same as `overview`). Writes the three files atomically into `<project>/.legacy-code-atlas/docs/`. Human output lists the three file paths and counts; `--json` prints `{ files, stats }`.

## OpenCode Skill integration

`SKILL.md` gains a "生成分享文档" section: when the user asks for shareable documents (文档 / UCS / UIS / 图), the Skill first uses the existing metadata-only index existence check, then runs one new fixed command:

```sh
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" docs "$PWD"
```

No user text is interpolated; the command joins the installer's required-fragments validation list in `install.ps1`. Failure stops with the exact error, consistent with the doctor/analyze/overview gates.

## Error handling

- Invalid/oversized index: rejected by the existing `loadGraph` validation before any file is written.
- Write failures: `writeFileAtomic` per file; the command fails with the standard CLI error path (exit 2), never leaving a partially-written file.
- Empty graphs: valid — documents render with "无" sections rather than failing.

## Testing

`test/docs.test.mjs`, TDD-first, against the `legacy-shop` fixture:

- Model: `/order/audit.do` use case includes the audit page trigger, the flow reaching `order.updateStatus` and `dbo.T_ORDER`, correct read/write classification; `audit.jsp` page spec lists fields `orderId/method/decision` and its actions.
- Determinism: two runs byte-identical; node insertion order does not change output.
- Safety: output contains no absolute paths (machine-path scan reused from worker-pool test patterns), hostile node names cannot escape Mermaid labels, caps produce truncation notices.
- CLI: `docs` writes exactly the three files, help documents the command, `--json` output shape.
- Integration/installer tests updated for the new fixed command in SKILL.md and install.ps1.

## Out of scope (YAGNI)

- No HTML/PDF/Word export — Markdown + Mermaid renders everywhere the team already works.
- No LLM-written prose — every sentence is derived from graph facts with citations; the OpenCode model may summarize the generated files afterwards, but the artifacts themselves stay deterministic.
- No per-use-case file splitting until a real project shows the single files are unwieldy.

## Version

`package.json` 0.1.0 → 0.2.0. The frozen benchmark baseline stays `legacy-code-atlas-0.1.0.tar.gz` (fixed archive name, unaffected).
