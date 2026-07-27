# Real-Project Analysis Accuracy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate evidence-backed UCS, UI specifications, and diagrams that remain useful on real legacy projects and fail clearly for an empty analysis target.

**Architecture:** Preserve all source observations in the graph, but classify business use cases at document-model time using backend and request evidence. Reconcile relative JSP requests with uniquely configured Struts actions during materialization, expose representative plus alternate backend flows, report selection versus detail truncation separately, and keep configured Struts outcomes distinct from direct code-return possibilities.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Markdown/Mermaid renderers.

---

### Task 1: Reject malformed dynamic markup targets

**Files:**
- Modify: `src/parsers/jsp.mjs`
- Modify: `src/file-facts.mjs`
- Test: `test/jsp-parser.test.mjs`

1. Add failing parser cases for nested JSTL `<c:out>`/truncated `<c:url>` values becoming encoded routes and punctuation-only visible text.
2. Reject unresolved markup fragments and require visible-text entries to contain a Unicode letter or number.
3. Bump the JSP parser version and run parser/cache tests.

### Task 2: Reconcile relative forms with configured Struts routes

**Files:**
- Modify: `src/materializer.mjs`
- Test: `test/materializer.test.mjs`

1. Add a failing graph test where one relative native form is reached from root and `/admin` contexts but a unique root Struts action exists.
2. Canonicalize static action extensions and static dynamic-method requests to that unique configured route while retaining the `action!method` suffix as an evidence-scoped dispatch hint.
3. Preserve ambiguous namespaces as separate unresolved observations, and retain multiple dynamic-method hints instead of selecting one method.

### Task 3: Separate business use cases from client navigation

**Files:**
- Modify: `src/doc-model.mjs`
- Modify: `src/doc-render.mjs`
- Test: `test/docs.test.mjs`

1. Add failing cases for static assets, direct JSP links, and root navigation appearing as UCS entries.
2. Retain those targets in page actions/navigation while excluding routes supported only by `links_to` and no backend flow.
3. Keep configured routes, forms, and script requests as executable or unresolved endpoints.

### Task 4: Render proven backend branches

**Files:**
- Modify: `src/doc-model.mjs`
- Modify: `src/doc-render.mjs`
- Test: `test/docs.test.mjs`

1. Add a branched route fixture whose two statement/table paths are both required in UCS output.
2. Preserve the representative `mainFlow` and add bounded distinct alternate backend paths with evidence.
3. Render alternate flows and explicit local truncation notices.

### Task 5: Correct truncation and empty-analysis reporting

**Files:**
- Modify: `src/doc-model.mjs`
- Modify: `src/doc-render.mjs`
- Modify: `bin/legacy-code-atlas.mjs`
- Test: `test/docs.test.mjs`
- Test: `test/cli.test.mjs`

1. Add failing assertions that local flow/action caps do not produce a whole-document truncation warning.
2. Expose `selectionTruncated` and `detailsTruncated`, keeping local notices next to affected sections.
3. Reject analyze/docs operations that would report success for no supported source/index nodes.

### Task 6: Classify configured Struts outcomes

**Files:**
- Modify: `src/parsers/java.mjs`
- Modify: `src/materializer.mjs`
- Modify: `src/doc-model.mjs`
- Modify: `src/doc-render.mjs`
- Modify: `src/render.mjs`
- Modify: `src/file-facts.mjs`
- Test: `test/java-parser.test.mjs`
- Test: `test/materializer.test.mjs`
- Test: `test/docs.test.mjs`
- Test: `test/query.test.mjs`
- Test: `test/file-processor.test.mjs`

1. Record direct literal `findForward("name")` and `return "name"` results on their exact Java methods, then bump the Java parser version so stale cache records cannot omit them.
2. Add `data.outcome.framework`, `name`, `classification`, and `codeEvidence` to each Struts configuration edge. Keep `confidence` as extraction confidence rather than overloading it with modality.
3. Upgrade a candidate only for one Struts route target, one resolved dispatch method, one unique configured result name, and a matching direct literal return. Keep dynamic returns, constants, duplicate names, multiple dispatch methods, missing source, and ambiguity as candidates.
4. Default missing, malformed, or evidence-free legacy metadata to `configured-candidate`, propagate the classification through UCS/UIS/diagrams/traces, and keep unrelated edge types unaffected even if their `data` contains an `outcome`-shaped object.

### Task 7: Full and real-project verification

**Files:**
- Verify: all changed source and test files
- Update: `docs/validation-thedailyplan.md`

1. Run focused parser, materializer, docs, and CLI tests.
2. Run `npm test`, explicit equivalence/determinism tests, `npm run benchmark`, and `git diff --check`.
3. Regenerate documents from the fixed TheDailyPlan repository root and inspect required/forbidden routes, dynamic/static JSP field facts, and key Java/SQL/procedure/table chains.
4. Assert that the index and documents expose configured candidates separately from code-confirmed possibilities, that old/invalid metadata never becomes proven by default, and that runtime field names or values are not presented as static literals.
5. Review the final diff, commit, and push only after every gate passes.
