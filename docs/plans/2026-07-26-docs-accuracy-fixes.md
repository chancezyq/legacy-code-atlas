# Generated Documentation Accuracy Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make scoped document selection, UI request metadata, scoped output paths, and Mermaid navigation accurately reflect the source evidence.

**Architecture:** Keep the existing graph schema and CLI protocol unchanged. Resolve scopes against the complete route and search-match sets before applying output caps, use reverse flow reachability for feature matches, correlate page actions with route request hints by their shared evidence locations, and use collision-resistant stable identities for generated paths and diagram nodes. Preserve repeated form observations as evidence on one logical graph edge, scope form parameters to their owning JSP form, and keep evidence merging linear without serializing cache state.

**Tech Stack:** Node.js 20+ ESM, `node:test`, built-in `node:crypto`, Markdown and Mermaid renderers.

---

### Task 1: Scope Before Output Caps

**Files:**
- Modify: `src/doc-model.mjs`
- Test: `test/docs.test.mjs`

1. Add a graph with 201 sorted routes and pages where the requested module is the final entry.
2. Assert that module scope selects that route and its page before the 200-entry caps are applied.
3. Run `node --test test/docs.test.mjs` and confirm the new assertion fails with an empty scope.
4. Resolve module scope from all routes, filter route candidates, then apply `MAX_USE_CASES`.
5. Derive scoped page candidates from the retained scoped routes before applying `MAX_PAGES`.
6. Re-run the focused test and confirm it passes.

### Task 2: Complete Feature Reachability

**Files:**
- Modify: `src/doc-model.mjs`
- Test: `test/docs.test.mjs`

1. Add a branched route where the searched table is reachable only through the non-primary path.
2. Assert that feature scope retains the route even though the searched node is absent from `mainFlow`.
3. Run the focused test and confirm the current main-path-only filter fails.
4. Find scoped route IDs by walking incoming `FLOW_EDGE_TYPES` from every search match, plus direct submission/request routes for matched pages.
5. Add regressions for a relevant 501st search match and for preventing a direct page trigger from becoming a new reverse-BFS seed.
6. Re-run the focused test and existing scope tests.

### Task 3: Evidence-Scoped Page Request Metadata

**Files:**
- Modify: `src/parsers/jsp.mjs`
- Modify: `src/file-facts.mjs`
- Modify: `src/graph.mjs`
- Modify: `src/materializer.mjs`
- Modify: `src/doc-model.mjs`
- Test: `test/jsp-parser.test.mjs`
- Test: `test/file-facts.test.mjs`
- Test: `test/graph.test.mjs`
- Test: `test/materializer.test.mjs`
- Test: `test/docs.test.mjs`

1. Add two pages that submit different methods/defaults to one shared route, with distinct evidence locations.
2. Assert that each page gets only its own HTTP method and default values.
3. Run the focused test and confirm the current aggregate route hints contaminate the second page.
4. Match route request hints to each page action by exact `file`, `line`, and `column` evidence before deriving methods and defaults.
5. Scope native and Struts fields to their containing form, bump the JSP parser version, and preserve repeated form evidence on one logical page-to-route edge.
6. Expand multiple matched form observations into separate page actions and leave conflicting defaults unknown.
7. Re-run the focused parser, graph, materializer, and document tests.

### Task 4: Collision-Resistant Scope Slugs and Page Identities

**Files:**
- Modify: `src/doc-model.mjs`
- Modify: `src/doc-render.mjs`
- Test: `test/docs.test.mjs`

1. Assert that two non-ASCII queries and two long same-prefix queries produce distinct safe slugs of at most 48 characters.
2. Assert that two `list.jsp` pages in different directories remain distinct nodes in the navigation diagram and that route redirects remain route nodes.
3. Run the focused test and confirm both assertions fail.
4. Preserve already-safe short ASCII slugs; otherwise append a stable truncated SHA-256 suffix.
5. Carry target IDs, paths, and types into outcomes and use stable graph IDs plus project-relative paths in Mermaid navigation.
6. Re-run the focused test and all renderer tests.

### Task 5: Robust JSP Form Extraction

**Files:**
- Modify: `src/parsers/jsp.mjs`
- Modify: `src/file-facts.mjs`
- Test: `test/jsp-parser.test.mjs`
- Test: `test/file-facts.test.mjs`

1. Add regressions for comments and inert element bodies containing form-like markup.
2. Add native `form="id"` ownership, Spring form tag, malformed form boundary, and many-form scaling cases.
3. Confirm the old parser extracts false requests, loses explicitly owned fields, misreads Spring fields, and rescans fields quadratically.
4. Mask structure-only regions without changing source offsets, parse exact tag names, index fields by range and owner, and bump the JSP parser cache version.
5. Re-run the complete JSP parser and file-fact cache tests.

### Task 6: Linear Edge Evidence Merging

**Files:**
- Modify: `src/graph.mjs`
- Test: `test/graph.test.mjs`

1. Instrument evidence key calculation and assert that repeated additions do only linear cumulative work.
2. Confirm the existing implementation rebuilds all historical evidence keys on every addition.
3. Keep per-edge evidence key state outside the serialized graph and invalidate it on observable evidence mutations.
4. Preserve `addEdge` retain-first behavior and deterministic evidence order.
5. Re-run graph, materializer, determinism, and frozen-baseline tests.

### Task 7: Existing Index Compatibility

**Files:**
- Modify: `src/doc-model.mjs`
- Test: `test/docs.test.mjs`

1. Reproduce the actual pre-fix schema-1.0 shape: multiple route hints but only the first evidence item on a repeated page-to-route edge.
2. Confirm later same-route forms disappear from generated page actions.
3. Recover same-file form hints only where their ownership is unambiguous; do not mix AJAX or link hints into form actions.
4. Leave metadata unknown when the old index cannot prove its request kind.
5. Re-run all document-model and renderer tests.

### Task 8: Bounded and Link-Safe Output Handling

**Files:**
- Modify: `bin/legacy-code-atlas.mjs`
- Modify: `src/cache.mjs`
- Test: `test/cli.test.mjs`
- Test: `test/cache.test.mjs`
- Test: `test/docs.test.mjs`

1. Reproduce a pre-existing symlink or junction in each generated documentation path and assert that the CLI rejects it without writing through the link.
2. Create valid JSON cache records nested deeply enough to overflow recursive inspection and assert that loading and saving treat only those records as cache misses.
3. Assert that the 512 MiB serialized-index limit is checked with `Buffer.byteLength` before allocating the output `Buffer`.
4. Create each documentation directory one segment at a time and verify both its entry type and canonical parent relationship before writing.
5. Catch excessive-depth failures at the cache-record boundary while preserving usable entries.
6. Re-run CLI, cache, and document-generation tests.

### Task 9: Installer Rename and Journal Compatibility

**Files:**
- Modify: `install.ps1`
- Modify: `test/helpers/windows-installer-harness.mjs`
- Test: `test/installer.test.mjs`
- Test: `test/installer-windows.test.mjs`

1. Reproduce upgrades and uninstalls from real v2/v3 manifests that own `~/.agents/skills/understand/SKILL.md`.
2. Accept only the exact `atlas` and legacy `understand` skill targets; continue rejecting third-party paths, sibling files, and reparse points.
3. Add a transaction-v3 journal that records the legacy skill hash, existence state, and backup before retiring the renamed namespace.
4. Recover transaction-v1/v2 journals by deriving and matching the actual `atlas` or `understand` namespace paths rather than assuming the new name.
5. Verify rollback after each migration crash point, reject a separately occupied `atlas` namespace during migration, and remove only an owned, non-reparse, empty skill directory on uninstall.
6. Verify that uninstalling an old `understand` manifest ignores an unrelated foreign `atlas` junction because that namespace is neither owned nor touched by the uninstall.
7. Parse the installer with official PowerShell and run all installer tests available on the host; report Windows PowerShell 5.1-only skips explicitly.

### Task 10: Complete and Well-Formed Mermaid Output

**Files:**
- Modify: `src/doc-render.mjs`
- Test: `test/docs.test.mjs`

1. Force the 1 MiB output limit while a Mermaid block is open and assert that the closing fence and warning both fit within the byte limit.
2. Assert that module overviews retain the route-to-Java-to-statement/procedure-to-table main-flow layers and use distinct documented shapes.
3. Exceed the 120-edge and 20-sequence caps and assert that every omitted set is accompanied by an explicit truncation notice.
4. Keep collision-resistant node identities and preserve meaningful suffixes in bounded labels.
5. Re-run the focused renderer regressions and the complete document test file.

### Task 11: Full Verification

**Files:**
- Verify: `src/doc-model.mjs`
- Verify: `src/doc-render.mjs`
- Verify: `test/docs.test.mjs`

1. Run `node --test test/docs.test.mjs`.
2. Run `npm test` and require zero failures.
3. Run the frozen baseline equivalence and determinism tests explicitly.
4. Run `npm run benchmark` and confirm the performance gate still passes.
5. Run `git diff --check` and inspect the final diff for unrelated changes.
6. Request an independent final code review and resolve all critical or important findings.
