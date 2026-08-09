import assert from "node:assert/strict";
import { cp, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeProject } from "../src/analyzer.mjs";
import {
  buildTechnicalEvidence,
  renderTechnicalEvidence,
  renderTechnicalInstructions,
  validateTechnicalDocument,
} from "../src/technical-doc.mjs";

const fixtureRoot = fileURLToPath(new URL("./fixtures/legacy-shop", import.meta.url));
const requiredHeadings = [
  "## 1. Overview",
  "## 2. Workflow Stages",
  "## 3. Database Tables",
  "## 4. Class Architecture",
  "## 5. Data Flow",
  "## 6. Business Rules",
  "## 7. Error Messages and Lookups",
  "## 8. Evidence Gaps",
];

function representativeDocument() {
  return [
    "# Order Audit Technical Workflow",
    "",
    ...requiredHeadings.flatMap((heading, index) => [
      heading,
      "",
      index === 0
        ? "The audit entry is mapped by Struts (`WEB-INF/struts-config.xml:5`)."
        : index === 1
          ? "**Derived:** The action delegates to the service (`src/com/acme/order/web/OrderAuditAction.java:14`, `src/com/acme/order/service/impl/OrderAuditServiceImpl.java:9`)."
          : index === 7
            ? "**Needs verification:** Transaction boundaries are not present in retained evidence (`src/com/acme/order/service/impl/OrderAuditServiceImpl.java:9`)."
            : "See the retained implementation evidence (`src/com/acme/order/dao/IbatisOrderDao.java:15`).",
      "",
    ]),
  ].join("\n");
}

async function validationProject(t) {
  const project = await mkdtemp(path.join(tmpdir(), "legacy-atlas-technical-doc-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await cp(fixtureRoot, project, { recursive: true });
  const outputDirectory = path.join(project, ".legacy-code-atlas", "docs", "technical", "orderaudit");
  await mkdir(outputDirectory, { recursive: true });
  return {
    project,
    outputDirectory,
    documentPath: path.join(outputDirectory, "Technical_Workflow_Design.md"),
    allowedFiles: new Set([
      "WEB-INF/struts-config.xml",
      "src/com/acme/order/web/OrderAuditAction.java",
      "src/com/acme/order/service/impl/OrderAuditServiceImpl.java",
      "src/com/acme/order/dao/IbatisOrderDao.java",
    ]),
  };
}

test("technical evidence gathers a complete feature dossier with citations", async () => {
  const graph = await analyzeProject(fixtureRoot);
  const evidence = buildTechnicalEvidence(graph, "OrderAudit");

  assert.equal(evidence.query, "OrderAudit");
  assert.equal(evidence.matched, true);
  assert.equal(evidence.matches.some(({ type }) => type === "file"), false);
  assert.ok(evidence.nodes.some(({ type, name }) => type === "route" && name === "/order/audit.do"));
  assert.ok(evidence.nodes.some(({ type, name }) => type === "page" && name === "audit.jsp"));
  assert.ok(evidence.nodes.some(({ type, name }) => type === "java_method" && name === "OrderAuditAction.audit"));
  assert.ok(evidence.nodes.some(({ type, name }) => type === "statement" && name === "order.insertAuditLog"));
  assert.ok(evidence.nodes.some(({ type, name }) => type === "table" && name === "dbo.t_order_audit_log"));
  assert.ok(evidence.outcomes.some(({ name, classification }) => name === "success" && classification === "code-confirmed"));
  assert.ok(evidence.outcomes.some(({ name, classification }) => name === "error" && classification === "configured-candidate"));
  assert.ok(evidence.fields.some(({ page, name }) => page.endsWith("audit.jsp") && name === "decision"));
  assert.ok(evidence.relations.every(({ evidence: refs }) => refs.every(({ file }) => !path.isAbsolute(file))));
  assert.ok(evidence.sourceFiles.includes("src/com/acme/order/web/OrderAuditAction.java"));
});

test("technical evidence renderer gives the model facts and a strict writing contract", async () => {
  const graph = await analyzeProject(fixtureRoot);
  const evidence = buildTechnicalEvidence(graph, "OrderAudit");
  const dossier = renderTechnicalEvidence(evidence);
  const instructions = renderTechnicalInstructions(evidence);

  for (const heading of [
    "# Technical Workflow Evidence: OrderAudit",
    "## Matched Scope",
    "## UI Fields",
    "## Source Relationships",
    "## Configured Outcomes",
    "## SQL Statements and Tables",
    "## Uncertainty and Warnings",
  ]) assert.match(dossier, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(dossier, /OrderAuditAction[.]java:\d+/u);
  assert.match(dossier, /order[.]insertAuditLog/u);
  assert.match(dossier, /dbo[.]t_order_audit_log/u);
  assert.match(dossier, /success[^\n]+code-confirmed/u);
  assert.match(dossier, /error[^\n]+configured-candidate/u);

  for (const heading of [
    "## 1. Overview",
    "## 2. Workflow Stages",
    "## 3. Database Tables",
    "## 4. Class Architecture",
    "## 5. Data Flow",
    "## 6. Business Rules",
    "## 7. Error Messages and Lookups",
    "## 8. Evidence Gaps",
  ]) assert.ok(instructions.includes(heading));
  assert.match(instructions, /Every concrete claim.*project-relative `path:line` citation/is);
  assert.match(instructions, /Derived/u);
  assert.match(instructions, /Needs verification/u);
});

test("technical evidence retains route and page entry matches when Java matches are wide", () => {
  const nodes = Array.from({ length: 40 }, (_, index) => ({
    id: `java_method:example.WideMatchHandler${String(index).padStart(2, "0")}#run/0`,
    type: "java_method",
    name: `WideMatchHandler${index}.run`,
    filePath: `src/example/WideMatchHandler${index}.java`,
    evidence: [{ file: `src/example/WideMatchHandler${index}.java`, line: 1, column: 1, snippet: "run" }],
    data: {},
    searchText: ["WideMatch"],
  }));
  nodes.push(
    { id: "page:web/wide-match.jsp", type: "page", name: "wide-match.jsp", filePath: "web/wide-match.jsp", evidence: [{ file: "web/wide-match.jsp", line: 1, column: 1, snippet: "WideMatch" }], data: {}, searchText: ["WideMatch"] },
    { id: "route:/wide-match.do", type: "route", name: "/wide-match.do", evidence: [{ file: "WEB-INF/struts-config.xml", line: 1, column: 1, snippet: "WideMatch" }], data: {}, searchText: ["WideMatch"] },
  );
  const edge = { id: "page:web/wide-match.jsp|submits_to|route:/wide-match.do|form", source: "page:web/wide-match.jsp", target: "route:/wide-match.do", type: "submits_to", confidence: 1, reason: "form", evidence: [{ file: "web/wide-match.jsp", line: 1, column: 1, snippet: "form" }], data: {} };
  const evidence = buildTechnicalEvidence({ nodes, edges: [edge], warnings: [] }, "WideMatch");

  assert.ok(evidence.nodes.some(({ id }) => id === "page:web/wide-match.jsp"));
  assert.ok(evidence.nodes.some(({ id }) => id === "route:/wide-match.do"));
  assert.equal(evidence.truncated, true);
  assert.ok(evidence.warnings.some((warning) => /search candidates.*truncated/i.test(warning)));
});

test("technical document validator reports section, citation, and uncertainty coverage", async (t) => {
  const { project, documentPath, allowedFiles } = await validationProject(t);
  await writeFile(documentPath, representativeDocument(), "utf8");

  const report = await validateTechnicalDocument(project, documentPath, { allowedFiles });

  assert.equal(report.ok, true);
  assert.equal(report.sections.present, requiredHeadings.length);
  assert.equal(report.sections.required, requiredHeadings.length);
  assert.ok(report.citations.total >= requiredHeadings.length);
  assert.ok(report.citations.files >= 4);
  assert.equal(report.markers.derived, 1);
  assert.equal(report.markers.needsVerification, 1);
  assert.deepEqual(report.errors, []);
});

test("technical document validator rejects malformed content and unsafe citations", async (t) => {
  const { project, documentPath, allowedFiles } = await validationProject(t);
  const cases = [
    ["missing required section", representativeDocument().replace("## 3. Database Tables", "## Database"), /missing required heading/i],
    ["no citation", requiredHeadings.map((heading) => `${heading}\n\nNo evidence.`).join("\n\n"), /at least one project-relative citation/i],
    ["absolute citation", representativeDocument().replace("WEB-INF/struts-config.xml:5", "/etc/passwd:1"), /unsafe citation path/i],
    ["parent citation", representativeDocument().replace("WEB-INF/struts-config.xml:5", "../outside.java:1"), /unsafe citation path/i],
    ["backslash citation", representativeDocument().replace("WEB-INF/struts-config.xml:5", "src\\Secret.java:1"), /unsafe citation path/i],
    ["file URL citation", representativeDocument().replace("WEB-INF/struts-config.xml:5", "file:///etc/passwd:1"), /unsafe citation path/i],
    ["missing source", representativeDocument().replace("WEB-INF/struts-config.xml:5", "src/Missing.java:1"), /citation file does not exist/i],
  ];

  for (const [name, contents, expected] of cases) {
    await writeFile(documentPath, contents, "utf8");
    const caseAllowedFiles = new Set(allowedFiles);
    if (name === "missing source") caseAllowedFiles.add("src/Missing.java");
    const report = await validateTechnicalDocument(project, documentPath, { allowedFiles: caseAllowedFiles });
    assert.equal(report.ok, false, name);
    assert.match(report.errors.join("\n"), expected, name);
  }

  await writeFile(documentPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(validateTechnicalDocument(project, documentPath, { allowedFiles }), /valid UTF-8/i);
});

test("technical document validator rejects fenced headings, out-of-scope files, and out-of-range lines", async (t) => {
  const { project, documentPath, allowedFiles } = await validationProject(t);
  const fenced = ["```markdown", ...requiredHeadings, "```", "", "`WEB-INF/struts-config.xml:5`"].join("\n");
  await writeFile(documentPath, fenced, "utf8");
  let report = await validateTechnicalDocument(project, documentPath, { allowedFiles });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /missing required heading/i);

  const fakeClose = ["```markdown", "``` not-a-close", ...requiredHeadings, "```", "", "`WEB-INF/struts-config.xml:5`"].join("\n");
  await writeFile(documentPath, fakeClose, "utf8");
  report = await validateTechnicalDocument(project, documentPath, { allowedFiles });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /missing required heading/i);

  await writeFile(documentPath, representativeDocument().replace("WEB-INF/struts-config.xml:5", "WEB-INF/struts-config.xml:999999"), "utf8");
  report = await validateTechnicalDocument(project, documentPath, { allowedFiles });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /citation line is outside file/i);

  await writeFile(documentPath, representativeDocument().replace("WEB-INF/struts-config.xml:5", "src/com/acme/a/OrderDao.java:1"), "utf8");
  report = await validateTechnicalDocument(project, documentPath, { allowedFiles });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /citation file is outside prepared evidence/i);

  await writeFile(documentPath, representativeDocument().replace(
    "The audit entry is mapped by Struts (`WEB-INF/struts-config.xml:5`).",
    "The audit entry is mapped by Struts.",
  ), "utf8");
  report = await validateTechnicalDocument(project, documentPath, { allowedFiles });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /section requires a citation or Needs verification/i);
});

test("technical document validator rejects linked output files", async (t) => {
  const { project, outputDirectory, documentPath, allowedFiles } = await validationProject(t);
  const external = path.join(outputDirectory, "external.md");
  await writeFile(external, representativeDocument(), "utf8");

  if (process.platform !== "win32") {
    await symlink(external, documentPath);
    await assert.rejects(validateTechnicalDocument(project, documentPath, { allowedFiles }), /symbolic link/i);
    await rm(documentPath);
  }

  await link(external, documentPath);
  await assert.rejects(validateTechnicalDocument(project, documentPath, { allowedFiles }), /hard link/i);
});
