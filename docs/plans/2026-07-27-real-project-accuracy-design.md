# Real-Project Analysis Accuracy Design

**Goal:** Make Atlas generate evidence-backed, useful project documentation on real JSP/Struts/Java/iBATIS projects instead of treating every browser target as a business use case.

**Observed regression:** On the fixed TheDailyPlan commit `e3571c8c3b1ee99e38f056f00d2189e9533f9cba`, release `7c75e0f` generated 37 use cases while current `faa9a85` generated 41 from nearly the same graph. The current output promoted static assets, direct JSP navigation, root locale links, and malformed JSTL targets to use cases; duplicated one relative form under an unrelated `/admin` arrival context; emitted punctuation-only UI text; and displayed a whole-document truncation warning for local flow caps. It also presented every configured Struts forward/result as an equally proven business outcome, even when the resolved Java method never returned that result. An empty source tree also produced a successful zero-node index and three empty documents.

## Evidence policy

Atlas keeps browser observations in the graph and UI navigation, but a route is a UCS entry only when there is evidence that it is executable: server configuration/code owns it, it has a proven backend flow, or a form/script request targets it. A target observed only through page links with no backend relation is navigation, not a business use case. Dynamic or malformed markup targets are not converted into literal encoded routes.

Relative requests are resolved against page arrival contexts, then reconciled with uniquely configured Struts routes. A unique configured action wins over duplicate contextual guesses; ambiguity remains explicit and is never guessed.

Configuration extraction and code-return modality are separate facts. A Struts outcome edge keeps its normal extraction `confidence`, while `data.outcome.classification` starts as `configured-candidate`. It becomes `code-confirmed` only for one resolved entry method, one unique configured name, and a matching direct literal return. Constants, variables, expressions, duplicate names, multiple dispatch methods, missing source, and older indexes stay candidates. `code-confirmed` means the source contains that return possibility; it does not claim that a particular request executes it.

## Document model

Each use case retains one representative main flow for compatibility and diagrams. Additional distinct, source-proven backend paths are rendered as bounded alternate flows so Java, statement, procedure, result, and table branches are not hidden behind aggregate lists. Selection truncation (dropped use cases/pages) is distinct from local detail truncation (flows, triggers, tables, actions, arrivals); only selection truncation produces the whole-document warning.

UI text contains meaningful Unicode letters or numbers, and punctuation-only parser artifacts are discarded. Dynamic field names are omitted with source warnings, runtime-derived values are not presented as static defaults, and static Struts 2 input `key` attributes can supply binding names. Generic taglib resource keys are not represented separately by the current fact schema; that remains an explicit limitation rather than being presented as rendered text.

UCS outcomes, UI arrival paths, main flows, and the navigation diagram carry the outcome classification. Configured candidates use explicit text and dashed Mermaid edges. Trace Markdown places them in a separate configured-candidate section instead of the proven or heuristic sections. Consumers of missing or invalid metadata default to candidate, never confirmed.

## Failure handling

`analyze` rejects a project with no supported files instead of writing a successful empty index. `docs` rejects a zero-node index as non-actionable. Legitimate scoped no-match output remains supported through `--no-match-ok`.

## Verification

Automated regressions cover malformed JSTL targets, unique Struts route reconciliation, client-navigation-only route filtering, alternate backend paths, truncation classification, meaningful UI text, empty-project rejection, direct literal Struts returns, multiple-dispatch ambiguity, duplicate result names, invalid legacy metadata, and non-outcome edge isolation. Before release, run focused tests, the complete test suite, equivalence and determinism tests, the benchmark, and regenerate all three documents from the fixed TheDailyPlan sample. The real-sample gate requires no static asset/direct-JSP/JSTL pseudo-use-cases, no duplicated `/admin/printPreviewDisplay.html`, preservation of the configured action-to-Java-to-SQL/table paths, and explicit candidate labels on every unconfirmed configured result.

The release-gate revalidation targets the fixed commit's repository root. An exploratory run against only `LegacyApp/tdpWeb` is not an accepted source of graph or document statistics. Final root-level statistics, warnings, and forbidden/required-route assertions are recorded in `docs/validation-thedailyplan.md`.
