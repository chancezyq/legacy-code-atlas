# Docs benchmark against industry tools (2026-07-24)

Research basis: verified 2025–2026 survey of diagram/doc generation tools (Mermaid v11.16 docs,
GitHub/GitLab rendering docs, c4model.com notation guidance, Structurizr, dependency-cruiser,
madge, tbls, AppMap, CAST Imaging) plus canonical spec templates (RUP/Cockburn use case
structure; standard screen-spec structure: field tables, navigation, actions).

## Where Atlas already matches the best tools

- Native GitHub/GitLab rendering: Mermaid `flowchart`/`sequenceDiagram` only, no experimental
  C4/architecture-beta types (aligned with the guidance to avoid them for durable output).
- Deterministic, evidence-cited output with hard caps — CAST-style "deterministic map" property
  that AI-rewritten docs lack.
- Scoped generation (`docs --query-file`) mirrors tbls "viewpoints" and `--distance` scoping.
- Source linkage as plain `file:line` text, not `click` handlers (stripped under GitHub's
  `securityLevel: strict`).

## Gaps identified and closed in this pass

1. UCS lacked the canonical use-case sections (trigger detail, inputs, outcomes/postconditions):
   - Added Request (HTTP methods + parameter names from route requestHints).
   - Added Inputs (form fields from trigger pages).
   - Added Outcomes (Struts forwards/redirects with result names — main/alternate flow endings).
   - Added SQL statements with operation type (select/insert/update/delete/procedure).
2. No CRUD-style matrix (CAST/legacy-doc staple): added a per-module data access matrix table
   (Table × Use case × Access).
3. UIS field list was flat: now a Markdown table (Field | Default value), defaults recovered
   from submitted route request hints; page actions now show the HTTP method.
4. Diagrams had no legends (c4model.com: every diagram must stand alone): flowcharts now carry
   a legend line; heuristic (confidence < 0.95) trigger edges render dashed (madge/dependency-
   cruiser semantic styling convention).
5. No navigation map (standard UIS artifact): added a screen-navigation Mermaid flowchart
   (pages -> routes -> forward/redirect targets) at the top of diagrams.md.

## Deliberately not adopted

- Mermaid `erDiagram`: our index has table names and access edges but no column/PK/FK facts;
  emitting a column-less ER diagram would imply schema knowledge we do not have. Revisit if a
  DDL parser lands.
- Native Mermaid C4 types: experimental, fixed styling; flowchart+subgraph is the compatible
  encoding.
- Runtime sequence diagrams (AppMap-style): Atlas is static-only by design.
- `click` interactivity: disabled on GitHub (`securityLevel: strict`).
