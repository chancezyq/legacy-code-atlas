import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseFileBuffer } from "../src/file-facts.mjs";
import { serializeGraph } from "../src/graph.mjs";
import { materializeRecords } from "../src/materializer.mjs";

const projectRoot = path.resolve("/tmp/legacy-materializer-project");

function record(relativePath, language, content, category = "code") {
  return parseFileBuffer(
    { path: relativePath, language, category, size: Buffer.byteLength(content) },
    Buffer.from(content),
  );
}

function edge(graph, source, type, target) {
  return graph.edges.find((candidate) => candidate.source === source && candidate.type === type && candidate.target === target);
}

test("materializer sorts per-file records before graph mutation and resolution", () => {
  const records = [
    record(
      "src/com/acme/OrderAction.java",
      "java",
      [
        "package com.acme;",
        "public class OrderAction {",
        "  public void execute() {}",
        "}",
        "",
      ].join("\n"),
    ),
    record(
      "WEB-INF/struts-config.xml",
      "xml",
      "<struts-config><action path='/order' type='com.acme.OrderAction'><forward name='ok' path='/order.jsp'/></action></struts-config>",
      "config",
    ),
    record(
      "web/order.jsp",
      "jsp",
      "<form action='/order.do' method='post'></form>",
      "markup",
    ),
  ];
  const skipped = [
    { path: "TooLarge.java", reason: "file-too-large" },
    { path: "Binary.java", reason: "binary-file" },
    { path: "Linked.java", reason: "symbolic-link" },
    { path: "logo.png", reason: "unsupported-file-type" },
  ];

  const forward = materializeRecords({ projectRoot, records, skipped });
  const reversed = materializeRecords({ projectRoot, records: [...records].reverse(), skipped: [...skipped].reverse() });

  assert.equal(serializeGraph(reversed), serializeGraph(forward));
  assert.ok(edge(forward, "page:web/order.jsp", "submits_to", "route:/order.do"));
  assert.ok(edge(forward, "route:/order.do", "maps_to", "java_type:com.acme.OrderAction"));
  assert.ok(edge(forward, "route:/order.do", "dispatches_to", "java_method:com.acme.OrderAction#execute/0"));
  assert.ok(edge(forward, "route:/order.do", "forwards_to", "page:web/order.jsp"));
  assert.deepEqual(forward.warnings.filter((warning) => warning.startsWith("skipped ")), [
    "skipped binary-file: Binary.java",
    "skipped file-too-large: TooLarge.java",
    "skipped symbolic-link: Linked.java",
  ]);
});

test("materializer preserves JavaScript and iBATIS graph mutations", () => {
  const records = [
    record("web/order.js", "javascript", "fetch('/order.do');\n"),
    record(
      "sqlmap/order.xml",
      "xml",
      "<sqlMap namespace='order'><update id='save'>UPDATE dbo.t_order SET status = 1</update></sqlMap>",
      "config",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "file:web/order.js", "requests", "route:/order.do"));
  assert.ok(edge(graph, "file:sqlmap/order.xml", "contains", "statement:order.save"));
  assert.ok(edge(graph, "statement:order.save", "writes_to", "table:dbo.t_order"));
});

test("materializer resolves calls through method-local Java variables", () => {
  const records = [
    record("src/com/acme/Caller.java", "java", [
      "package com.acme;",
      "public class Caller {",
      "  public void execute() {",
      "    OrderService service = lookupService();",
      "    service.audit();",
      "  }",
      "}",
    ].join("\n")),
    record("src/com/acme/OrderService.java", "java", [
      "package com.acme;",
      "public class OrderService {",
      "  public void audit() {}",
      "}",
    ].join("\n")),
    record("src/com/acme/OtherService.java", "java", [
      "package com.acme;",
      "public class OtherService {",
      "  public void audit() {}",
      "}",
    ].join("\n")),
  ];

  const graph = materializeRecords({ projectRoot, records });

  const call = edge(
    graph,
    "java_method:com.acme.Caller#execute/0",
    "calls",
    "java_method:com.acme.OrderService#audit/0",
  );
  assert.ok(call);
  assert.equal(call.reason, "local variable type OrderService");
  assert.equal(graph.edges.some((candidate) => candidate.type === "calls" && candidate.target === "java_method:com.acme.OtherService#audit/0"), false);
});

test("materializer resolves calls through inherited no-argument method return types", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/BaseAction.java", "java", [
        "package com.acme;",
        "public class BaseAction {",
        "  protected PetStoreFacade getPetStore() { return null; }",
        "}",
      ].join("\n")),
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction extends BaseAction {",
        "  public void execute() { getPetStore().updateAccount(); }",
        "}",
      ].join("\n")),
      record("src/com/acme/PetStoreFacade.java", "java", [
        "package com.acme;",
        "public class PetStoreFacade {",
        "  public void updateAccount() {}",
        "}",
      ].join("\n")),
    ],
  });

  assert.ok(edge(
    graph,
    "java_method:com.acme.OrderAction#execute/0",
    "calls",
    "java_method:com.acme.PetStoreFacade#updateAccount/0",
  ));
});

test("materializer keeps same-arity overloaded Java methods as separate nodes", () => {
  const records = [
    record("src/com/acme/Caller.java", "java", [
      "package com.acme;",
      "public class Caller {",
      "  public void execute(String value) {",
      "    FirstService service = lookupFirst();",
      "    service.audit();",
      "  }",
      "  public void execute(Integer value) {",
      "    SecondService service = lookupSecond();",
      "    service.audit();",
      "  }",
      "}",
    ].join("\n")),
    record("src/com/acme/FirstService.java", "java", [
      "package com.acme;",
      "public class FirstService {",
      "  public void audit() {}",
      "}",
    ].join("\n")),
    record("src/com/acme/SecondService.java", "java", [
      "package com.acme;",
      "public class SecondService {",
      "  public void audit() {}",
      "}",
    ].join("\n")),
  ];

  const graph = materializeRecords({ projectRoot, records });
  assert.ok(graph.nodes.some((node) => node.id === "java_method:com.acme.Caller#execute/1(String)"));
  assert.ok(graph.nodes.some((node) => node.id === "java_method:com.acme.Caller#execute/1(Integer)"));
  assert.ok(edge(graph, "java_method:com.acme.Caller#execute/1(String)", "calls", "java_method:com.acme.FirstService#audit/0"));
  assert.ok(edge(graph, "java_method:com.acme.Caller#execute/1(Integer)", "calls", "java_method:com.acme.SecondService#audit/0"));
  assert.equal(graph.edges.some((candidate) => candidate.type === "calls"
    && candidate.source === "java_method:com.acme.Caller#execute/1(String)"
    && candidate.target === "java_method:com.acme.SecondService#audit/0"), false);
  assert.equal(graph.edges.some((candidate) => candidate.type === "calls"
    && candidate.source === "java_method:com.acme.Caller#execute/1(Integer)"
    && candidate.target === "java_method:com.acme.FirstService#audit/0"), false);
});

test("materializer matches interface overloads across simple and qualified parameter types", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Contract.java", "java", [
        "package com.acme;",
        "public interface Contract {",
        "  void save(String value);",
        "  void save(Integer value);",
        "}",
      ].join("\n")),
      record("src/com/acme/Impl.java", "java", [
        "package com.acme;",
        "public class Impl implements Contract {",
        "  public void save(java.lang.String value) {}",
        "  public void save(java.lang.Integer value) {}",
        "}",
      ].join("\n")),
    ],
  });

  const methodEdges = graph.edges.filter((candidate) => candidate.type === "implemented_by"
    && candidate.source.startsWith("java_method:"));
  assert.deepEqual(methodEdges.map(({ source, target }) => [source, target]), [
    ["java_method:com.acme.Contract#save/1(Integer)", "java_method:com.acme.Impl#save/1(java.lang.Integer)"],
    ["java_method:com.acme.Contract#save/1(String)", "java_method:com.acme.Impl#save/1(java.lang.String)"],
  ]);
});

test("materializer links Struts JSP taglib forms to DispatchAction methods", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("web/order/edit.jsp", "jsp", [
        '<html:form action="/order/audit" method="post">',
        '  <html:hidden property="method" value="audit" />',
        "</html:form>",
      ].join("\n"), "markup"),
      record("WEB-INF/struts-config.xml", "xml", "<struts-config><action path='/order/audit' type='com.acme.OrderAction' parameter='method'/></struts-config>", "config"),
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction extends DispatchAction {",
        "  public void audit() {}",
        "}",
      ].join("\n")),
    ],
  });

  assert.ok(edge(graph, "page:web/order/edit.jsp", "submits_to", "route:/order/audit.do"));
  assert.ok(edge(graph, "route:/order/audit.do", "dispatches_to", "java_method:com.acme.OrderAction#audit/0"));
});

test("materializer keeps parser failures isolated and emits a deterministic warning", () => {
  const failed = parseFileBuffer(
    { path: "src/Broken.java", language: "java", category: "code", size: 12 },
    Buffer.from("class Broken"),
    { parsers: { java: () => { throw new Error("machine-specific details"); } } },
  );

  const graph = materializeRecords({ projectRoot, records: [failed] });

  assert.equal(graph.nodes.some((node) => node.id === "file:src/Broken.java"), true);
  assert.deepEqual(graph.warnings, ["skipped parser-error: src/Broken.java"]);
});

test("materializer links iBATIS procedures to SQL Server procedure calls and tables", () => {
  const records = [
    record(
      "db/order.sql",
      "sql",
      [
        "CREATE PROCEDURE dbo.usp_OrderAudit @OrderId int",
        "AS",
        "BEGIN",
        "  SELECT * FROM dbo.T_ORDER WHERE ORDER_ID = @OrderId;",
        "  EXEC dbo.usp_WriteAudit @OrderId;",
        "END",
        "GO",
        "CREATE PROCEDURE dbo.usp_WriteAudit @OrderId int",
        "AS",
        "INSERT INTO dbo.T_AUDIT (ORDER_ID) VALUES (@OrderId);",
        "GO",
      ].join("\n"),
      "database",
    ),
    record(
      "sqlmap/order.xml",
      "xml",
      "<sqlMap namespace='order'><procedure id='audit'>{call dbo.usp_OrderAudit(#id#)}</procedure></sqlMap>",
      "config",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(graph.nodes.some((node) => node.id === "procedure:dbo.usp_orderaudit"));
  assert.ok(graph.nodes.some((node) => node.id === "procedure:dbo.usp_writeaudit"));
  assert.ok(edge(graph, "file:db/order.sql", "contains", "procedure:dbo.usp_orderaudit"));
  assert.ok(edge(graph, "statement:order.audit", "calls_procedure", "procedure:dbo.usp_orderaudit"));
  assert.ok(edge(graph, "procedure:dbo.usp_orderaudit", "calls", "procedure:dbo.usp_writeaudit"));
  assert.ok(edge(graph, "procedure:dbo.usp_orderaudit", "reads_from", "table:dbo.t_order"));
  assert.ok(edge(graph, "procedure:dbo.usp_writeaudit", "writes_to", "table:dbo.t_audit"));
});

test("materializer resolves Struts 2 action methods and result pages", () => {
  const records = [
    record(
      "src/com/acme/OrderAction.java",
      "java",
      [
        "package com.acme;",
        "public class OrderAction {",
        "  public String save() { return \"success\"; }",
        "}",
      ].join("\n"),
    ),
    record(
      "WEB-INF/struts.xml",
      "xml",
      "<struts><package namespace='/order'><action name='save' class='com.acme.OrderAction' method='save'><result name='success'>/order/success.jsp</result></action></package></struts>",
      "config",
    ),
    record("web/order/success.jsp", "jsp", "<h1>saved</h1>", "markup"),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "route:/order/save.action", "maps_to", "java_type:com.acme.OrderAction"));
  const dispatch = edge(graph, "route:/order/save.action", "dispatches_to", "java_method:com.acme.OrderAction#save/0");
  assert.ok(dispatch);
  assert.equal(dispatch.confidence, 1);
  assert.ok(edge(graph, "route:/order/save.action", "forwards_to", "page:web/order/success.jsp"));
});

test("Struts 2 routes honor the configured action extension", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        "  public String save() { return \"success\"; }",
        "}",
      ].join("\n")),
      record(
        "WEB-INF/struts.xml",
        "xml",
        "<struts><constant name='struts.action.extension' value='html'/><package namespace='/order'><action name='save' class='com.acme.OrderAction' method='save'/></package></struts>",
        "config",
      ),
    ],
  });

  assert.ok(edge(graph, "route:/order/save.html", "maps_to", "java_type:com.acme.OrderAction"));
  assert.equal(graph.nodes.some((node) => node.id === "route:/order/save.action"), false);
});

test("Struts 2 default execute dispatch remains heuristic", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        "  public String execute() { return \"success\"; }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts.xml", "xml", "<struts><package namespace='/order'><action name='save' class='com.acme.OrderAction'/></package></struts>", "config"),
    ],
  });
  const dispatch = edge(graph, "route:/order/save.action", "dispatches_to", "java_method:com.acme.OrderAction#execute/0");
  assert.ok(dispatch);
  assert.equal(dispatch.confidence, 0.9);
});

test("materializer links Tiles definitions to templates, put pages, and inheritance", () => {
  const records = [
    record("web/WEB-INF/layout.jsp", "jsp", "<div><jsp:include page='/order.jsp'/></div>", "markup"),
    record("web/order.jsp", "jsp", "<h1>order</h1>", "markup"),
    record(
      "WEB-INF/tiles.xml",
      "xml",
      "<tiles-definitions><definition name='base.page' template='/WEB-INF/layout.jsp'/><definition name='order.page' extends='base.page' template='/WEB-INF/layout.jsp'><put name='body' value='/order.jsp'/></definition></tiles-definitions>",
      "config",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(graph.nodes.some((node) => node.id === "tiles_definition:order.page"));
  assert.ok(edge(graph, "file:WEB-INF/tiles.xml", "contains", "tiles_definition:order.page"));
  assert.ok(edge(graph, "tiles_definition:order.page", "extends_tile", "tiles_definition:base.page"));
  assert.ok(edge(graph, "tiles_definition:order.page", "uses_template", "page:web/WEB-INF/layout.jsp"));
  assert.ok(edge(graph, "tiles_definition:order.page", "puts", "page:web/order.jsp"));
});

test("Struts 1 forwards can target a Tiles definition", () => {
  const records = [
    record(
      "WEB-INF/struts-config.xml",
      "xml",
      "<struts-config><action path='/order' type='com.acme.OrderAction'><forward name='success' path='order.page'/></action></struts-config>",
      "config",
    ),
    record(
      "WEB-INF/tiles.xml",
      "xml",
      "<tiles-definitions><definition name='order.page' template='/layout.jsp'/></tiles-definitions>",
      "config",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "route:/order.do", "uses_tile", "tiles_definition:order.page"));
  assert.equal(graph.nodes.some((node) => node.id === "page:order.page"), false);
});

test("Struts 2 redirectAction results become route redirects", () => {
  const records = [
    record(
      "WEB-INF/struts.xml",
      "xml",
      "<struts><package namespace='/order'><action name='save' class='com.acme.OrderAction'><result name='success' type='redirectAction'>review.action</result></action></package></struts>",
      "config",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "route:/order/save.action", "redirects_to", "route:/order/review.action"));
  assert.equal(graph.nodes.some((node) => node.id === "page:review"), false);
});

test("Struts 2 redirectAction targets honor the configured action extension", () => {
  const records = [
    record(
      "WEB-INF/struts.xml",
      "xml",
      "<struts><constant name='struts.action.extension' value='html'/><package namespace='/order'><action name='save' class='com.acme.OrderAction'><result name='success' type='redirectAction'>review</result></action><action name='review' class='com.acme.ReviewAction'/></package></struts>",
      "config",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "route:/order/save.html", "redirects_to", "route:/order/review.html"));
  assert.equal(graph.nodes.some((node) => node.id === "route:/order/review.action"), false);
});

test("JSP Struts 2 tags resolve unique namespaced actions with configured extensions", () => {
  const records = [
    record(
      "WEB-INF/struts.xml",
      "xml",
      "<struts><constant name='struts.action.extension' value='html'/><package namespace='/admin'><action name='saveDefinition' class='com.acme.DefinitionAction' method='save'/></package></struts>",
      "config",
    ),
    record(
      "web/WEB-INF/pages/admin/definitionForm.jsp",
      "jsp",
      "<s:form action='saveDefinition' method='post'><input type='submit'/></s:form>",
      "markup",
    ),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "page:web/WEB-INF/pages/admin/definitionForm.jsp", "submits_to", "route:/admin/saveDefinition.html"));
  assert.equal(graph.nodes.some((node) => node.id === "route:/saveDefinition.action"), false);
});

test("Struts 2 action bean ids resolve through Spring bean classes", () => {
  const records = [
    record(
      "src/com/acme/SaveAction.java",
      "java",
      [
        "package com.acme;",
        "public class SaveAction {",
        "  public String save() { return \"success\"; }",
        "}",
      ].join("\n"),
    ),
    record("WEB-INF/applicationContext-struts.xml", "xml", "<beans><bean id='saveAction' class='com.acme.SaveAction'/></beans>", "config"),
    record("WEB-INF/struts.xml", "xml", "<struts><package namespace='/order'><action name='save' class='saveAction' method='save'/></package></struts>", "config"),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "route:/order/save.action", "maps_to", "java_type:com.acme.SaveAction"));
  assert.ok(edge(graph, "route:/order/save.action", "dispatches_to", "java_method:com.acme.SaveAction#save/0"));
  assert.equal(graph.warnings.some((warning) => warning.includes("saveAction")), false);
});

test("Struts 2 action bean ids stay unresolved when Spring classes conflict", () => {
  const records = [
    record("src/com/acme/FirstAction.java", "java", "package com.acme; public class FirstAction { public String save() { return \"success\"; } }"),
    record("src/com/acme/SecondAction.java", "java", "package com.acme; public class SecondAction { public String save() { return \"success\"; } }"),
    record("WEB-INF/applicationContext-a.xml", "xml", "<beans><bean id='saveAction' class='com.acme.FirstAction'/></beans>", "config"),
    record("WEB-INF/applicationContext-b.xml", "xml", "<beans><bean id='saveAction' class='com.acme.SecondAction'/></beans>", "config"),
    record("WEB-INF/struts.xml", "xml", "<struts><package namespace='/order'><action name='save' class='saveAction' method='save'/></package></struts>", "config"),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.equal(graph.edges.some((candidate) => candidate.source === "route:/order/save.action" && candidate.type === "maps_to"), false);
  assert.equal(graph.warnings.some((warning) => warning.includes("ambiguous Spring bean") && warning.includes("saveAction")), true);
});

test("Tiles inheritance resolves across XML files independent of record order", () => {
  const records = [
    record("WEB-INF/child-tiles.xml", "xml", "<tiles-definitions><definition name='order.page' extends='base.page' template='/order-layout.jsp'/></tiles-definitions>", "config"),
    record("WEB-INF/base-tiles.xml", "xml", "<tiles-definitions><definition name='base.page' template='/layout.jsp'/></tiles-definitions>", "config"),
  ];

  const graph = materializeRecords({ projectRoot, records: [...records].reverse() });

  assert.ok(edge(graph, "tiles_definition:order.page", "extends_tile", "tiles_definition:base.page"));
  assert.equal(graph.warnings.some((warning) => warning.includes("base.page")), false);
});
