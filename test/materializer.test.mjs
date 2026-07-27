import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseFileBuffer } from "../src/file-facts.mjs";
import { buildDocumentModel } from "../src/doc-model.mjs";
import { serializeGraph } from "../src/graph.mjs";
import { materializeRecords } from "../src/materializer.mjs";
import { effectiveTilePages } from "../src/tile-composition.mjs";

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
        "  public ActionForward execute(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) { return null; }",
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
  assert.ok(edge(forward, "route:/order.do", "dispatches_to", "java_method:com.acme.OrderAction#execute/4"));
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

test("external JavaScript requests inherit every loading page context", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("web/a/edit.jsp", "jsp", '<script src="/js/app.js"></script>', "markup"),
      record("web/b/edit.jsp", "jsp", '<script src="/js/app.js"></script>', "markup"),
      record("web/js/app.js", "javascript", [
        "fetch('save.do');",
        "fetch('/absolute.do');",
      ].join("\n")),
    ],
  });
  const model = buildDocumentModel(graph);

  assert.equal(graph.nodes.some((node) => node.id === "route:save.do"), false);
  for (const prefix of ["a", "b"]) {
    assert.ok(edge(graph, "file:web/js/app.js", "requests", `route:/${prefix}/save.do`));
    assert.equal(edge(graph, `page:web/${prefix}/edit.jsp`, "requests", `route:/${prefix}/save.do`), undefined);
    const useCase = model.useCases.find(({ route }) => route === `/${prefix}/save.do`);
    assert.ok(useCase.triggers.some(({ pagePath }) => pagePath === `web/${prefix}/edit.jsp`));
    const page = model.pages.find(({ filePath }) => filePath === `web/${prefix}/edit.jsp`);
    assert.ok(page.actions.some(({ target }) => target === `/${prefix}/save.do`));
  }
  assert.ok(edge(graph, "file:web/js/app.js", "requests", "route:/absolute.do"));
  assert.equal(edge(graph, "page:web/a/edit.jsp", "requests", "route:/absolute.do"), undefined);
  assert.equal(edge(graph, "page:web/b/edit.jsp", "requests", "route:/absolute.do"), undefined);
  const absolute = model.useCases.find(({ route }) => route === "/absolute.do");
  assert.deepEqual(absolute.triggers.map(({ pagePath }) => pagePath), ["web/a/edit.jsp", "web/b/edit.jsp"]);
});

test("external JavaScript request contexts stay scoped to their own evidence", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config>",
        "  <action path='/a/edit' type='com.acme.EditAction'><forward name='view' path='/a.jsp'/></action>",
        "  <action path='/b/edit' type='com.acme.EditAction'><forward name='view' path='/b.jsp'/></action>",
        "</struts-config>",
      ].join("\n"), "config"),
      record("web/a.jsp", "jsp", '<script src="/js/app.js"></script>', "markup"),
      record("web/b.jsp", "jsp", '<script src="/js/app.js"></script>', "markup"),
      record("web/js/app.js", "javascript", [
        'fetch("save.do", { method: "POST" });',
        'fetch("../a/save.do", { method: "GET" });',
        'fetch("/absolute.do", { method: "DELETE" });',
        'fetch("../../absolute.do", { method: "PATCH" });',
      ].join("\n")),
    ],
  });
  const model = buildDocumentModel(graph);
  const route = graph.nodes.find(({ id }) => id === "route:/a/save.do");

  assert.deepEqual(route.data.requestHints.map(({ method }) => method).sort(), ["GET", "POST"]);
  assert.deepEqual(
    model.pages.find(({ filePath }) => filePath === "web/a.jsp").actions
      .filter(({ target }) => target === "/a/save.do")
      .map(({ method }) => method)
      .sort(),
    ["GET", "POST"],
  );
  assert.deepEqual(
    model.pages.find(({ filePath }) => filePath === "web/b.jsp").actions
      .filter(({ target }) => target === "/a/save.do")
      .map(({ method }) => method),
    ["GET"],
  );

  assert.deepEqual(
    model.pages.find(({ filePath }) => filePath === "web/a.jsp").actions
      .filter(({ target }) => target === "/absolute.do")
      .map(({ method }) => method)
      .sort(),
    ["DELETE", "PATCH"],
  );
  assert.deepEqual(
    model.pages.find(({ filePath }) => filePath === "web/b.jsp").actions
      .filter(({ target }) => target === "/absolute.do")
      .map(({ method }) => method)
      .sort(),
    ["DELETE", "PATCH"],
  );
});

test("relative external JavaScript requests without a loading page stay unresolved", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/js/orphan.js", "javascript", "fetch('save.do');")],
  });

  assert.equal(graph.nodes.some((node) => node.type === "route"), false);
  assert.ok(graph.warnings.some((warning) => warning.includes("unresolved relative JavaScript request: save.do")));
});

test("unknown fetch methods survive materialization into document requests", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/js/app.js", "javascript", "fetch('/orders.do', { method: verb });")],
  });
  const model = buildDocumentModel(graph);

  assert.equal(model.useCases.find(({ route }) => route === "/orders.do").request.hasUnknownMethod, true);
});

test("relative browser requests resolve from every route arrival context", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config>",
        "  <action path='/orders/edit' type='com.acme.EditAction'><forward name='view' path='/WEB-INF/views/edit.jsp'/></action>",
        "  <action path='/admin/edit' type='com.acme.EditAction'><forward name='view' path='/WEB-INF/views/edit.jsp'/></action>",
        "</struts-config>",
      ].join("\n"), "config"),
      record("web/WEB-INF/views/edit.jsp", "jsp", [
        '<form action="save.do" method="post"><input name="id" value="7"></form>',
        '<a href="list.do">List</a>',
        '<script>fetch("inline.do")</script>',
        '<script src="/js/app.js"></script>',
      ].join("\n"), "markup"),
      record("web/js/app.js", "javascript", 'fetch("external.do");'),
    ],
  });

  for (const prefix of ["orders", "admin"]) {
    assert.ok(edge(graph, "page:web/WEB-INF/views/edit.jsp", "submits_to", `route:/${prefix}/save.do`));
    assert.ok(edge(graph, "page:web/WEB-INF/views/edit.jsp", "links_to", `route:/${prefix}/list.do`));
    assert.ok(edge(graph, "page:web/WEB-INF/views/edit.jsp", "requests", `route:/${prefix}/inline.do`));
    const external = edge(graph, "file:web/js/app.js", "requests", `route:/${prefix}/external.do`);
    assert.ok(external);
    assert.deepEqual(external.data.pageIds, ["page:web/WEB-INF/views/edit.jsp"]);
  }
  assert.equal(graph.nodes.some(({ id }) => id.startsWith("route:/WEB-INF/views/")), false);
});

test("current-document requests use the post-redirect route URL", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("WEB-INF/struts.xml", "xml", [
        "<struts><package namespace='/orders'>",
        "  <action name='start' class='com.acme.StartAction'>",
        "    <result name='success' type='redirectAction'>review</result>",
        "  </action>",
        "  <action name='review' class='com.acme.ReviewAction'>",
        "    <result name='success'>/WEB-INF/views/review.jsp</result>",
        "  </action>",
        "</package></struts>",
      ].join("\n"), "config"),
      record("web/WEB-INF/views/review.jsp", "jsp", [
        '<form action=""><input name="id" value="7"></form>',
        '<a href="?tab=detail">Details</a>',
        '<script src="/js/review.js"></script>',
      ].join("\n"), "markup"),
      record("web/js/review.js", "javascript", 'fetch(""); fetch("?refresh=1");'),
    ],
  });
  const route = graph.nodes.find(({ id }) => id === "route:/orders/review.action");

  assert.ok(edge(graph, "route:/orders/start.action", "redirects_to", route.id));
  assert.ok(edge(graph, "page:web/WEB-INF/views/review.jsp", "submits_to", route.id));
  assert.ok(edge(graph, "page:web/WEB-INF/views/review.jsp", "links_to", route.id));
  assert.ok(edge(graph, "file:web/js/review.js", "requests", route.id));
  assert.equal(edge(graph, "page:web/WEB-INF/views/review.jsp", "submits_to", "route:/orders/start.action"), undefined);
  assert.equal(edge(graph, "page:web/WEB-INF/views/review.jsp", "links_to", "route:/orders/start.action"), undefined);
  assert.equal(edge(graph, "file:web/js/review.js", "requests", "route:/orders/start.action"), undefined);
  assert.deepEqual(
    route.data.requestHints.map(({ parameters }) => parameters),
    [{ id: "7" }, { tab: "detail" }, {}, { refresh: "1" }],
  );
  assert.equal(graph.nodes.some(({ id }) => id === "route:/orders/start.action?tab=detail"), false);
  assert.equal(graph.nodes.some(({ id }) => id.startsWith("route:/WEB-INF/views/")), false);
});

test("relative script sources resolve from the document route", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts-config.xml",
        "xml",
        "<struts-config><action path='/orders/edit' type='com.acme.EditAction'><forward name='view' path='/WEB-INF/views/edit.jsp'/></action></struts-config>",
        "config",
      ),
      record("web/WEB-INF/views/edit.jsp", "jsp", '<script src="assets/app.js"></script>', "markup"),
      record("web/orders/assets/app.js", "javascript", 'fetch("save.do");'),
    ],
  });

  assert.ok(edge(graph, "page:web/WEB-INF/views/edit.jsp", "loads_script", "file:web/orders/assets/app.js"));
  assert.ok(edge(graph, "file:web/orders/assets/app.js", "requests", "route:/orders/save.do"));
  assert.equal(graph.warnings.some((warning) => warning.includes("unresolved JSP script")), false);
  assert.equal(graph.nodes.some(({ id }) => id.startsWith("route:/WEB-INF/views/")), false);
});

test("included JSP scripts inherit the top-level document page and route", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config>",
        "  <action path='/orders/edit' type='com.acme.EditAction'><forward name='view' path='/WEB-INF/views/edit.jsp'/></action>",
        "</struts-config>",
      ].join("\n"), "config"),
      record("web/WEB-INF/views/edit.jsp", "jsp", '<jsp:include page="/WEB-INF/views/widget.jsp" />', "markup"),
      record("web/WEB-INF/views/widget.jsp", "jsp", '<script src="/js/app.js"></script>', "markup"),
      record("web/js/app.js", "javascript", 'fetch("save.do");'),
    ],
  });
  const model = buildDocumentModel(graph);

  assert.ok(edge(graph, "page:web/WEB-INF/views/edit.jsp", "loads_script", "file:web/js/app.js"));
  assert.equal(edge(graph, "page:web/WEB-INF/views/widget.jsp", "loads_script", "file:web/js/app.js"), undefined);
  assert.ok(edge(graph, "file:web/js/app.js", "requests", "route:/orders/save.do"));
  assert.equal(graph.nodes.some(({ id }) => id === "route:/WEB-INF/views/save.do"), false);
  const useCase = model.useCases.find(({ route }) => route === "/orders/save.do");
  assert.deepEqual(useCase.triggers.map(({ pagePath }) => pagePath), ["web/WEB-INF/views/edit.jsp"]);
});

test("materializer ignores unresolved include paths from legacy cached facts", () => {
  const jspRecord = record("web/source.jsp", "jsp", "<h1>Source</h1>", "markup");
  jspRecord.facts.includes = [{
    path: "${dynamicTarget}",
    evidence: {
      file: "web/source.jsp",
      line: 1,
      column: 1,
      snippet: '<jsp:include page="${dynamicTarget}" />',
    },
  }];

  const graph = materializeRecords({ projectRoot, records: [jspRecord] });

  assert.equal(graph.nodes.some(({ id }) => id === "page:"), false);
  assert.equal(graph.edges.some(({ type }) => type === "includes"), false);
});

test("include cycles terminate and retain the top-level document context", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts-config.xml",
        "xml",
        "<struts-config><action path='/cycle/view' type='com.acme.ViewAction'><forward name='view' path='/a.jsp'/></action></struts-config>",
        "config",
      ),
      record("web/a.jsp", "jsp", '<jsp:include page="/b.jsp" />', "markup"),
      record("web/b.jsp", "jsp", '<jsp:include page="/a.jsp" /><script>fetch("save.do")</script>', "markup"),
    ],
  });

  assert.ok(edge(graph, "page:web/a.jsp", "requests", "route:/cycle/save.do"));
  assert.equal(edge(graph, "page:web/b.jsp", "requests", "route:/cycle/save.do"), undefined);
  assert.equal(graph.edges.filter((candidate) => candidate.target === "route:/cycle/save.do").length, 1);
});

test("browser request edges do not become document arrival contexts", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts-config.xml",
        "xml",
        "<struts-config><action path='/target/view' type='com.acme.ViewAction'><forward name='view' path='/target.jsp'/></action></struts-config>",
        "config",
      ),
      record("web/source/source.jsp", "jsp", [
        '<a href="/target/view.do">Target</a>',
        '<script>fetch("save.do")</script>',
      ].join("\n"), "markup"),
      record("web/target.jsp", "jsp", "<h1>Target</h1>", "markup"),
    ],
  });

  assert.ok(edge(graph, "page:web/source/source.jsp", "requests", "route:/source/save.do"));
  assert.equal(edge(graph, "page:web/source/source.jsp", "requests", "route:/target/save.do"), undefined);
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

test("materializer resolves calls through imported and same-package canonical member types", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Container.java", "java", [
        "package com.acme;",
        "public class Container {",
        "  public static class Service {",
        "    public void work() {}",
        "  }",
        "  private Service service;",
        "  public void run() { service.work(); }",
        "  public static class Client {",
        "    private Service service;",
        "    public void run() { service.work(); }",
        "  }",
        "}",
      ].join("\n")),
      record("src/com/acme/OtherService.java", "java", [
        "package com.acme;",
        "public class OtherService {",
        "  public void work() {}",
        "}",
      ].join("\n")),
      record("src/caller/ImportedCaller.java", "java", [
        "package caller;",
        "import com.acme.Container.Service;",
        "public class ImportedCaller {",
        "  private Service service;",
        "  public void run() { service.work(); }",
        "}",
      ].join("\n")),
      record("src/com/acme/QualifiedCaller.java", "java", [
        "package com.acme;",
        "public class QualifiedCaller {",
        "  private Container.Service service;",
        "  public void run() { service.work(); }",
        "}",
      ].join("\n")),
      record("src/caller/WildcardCaller.java", "java", [
        "package caller;",
        "import com.acme.Container.*;",
        "public class WildcardCaller {",
        "  private Service service;",
        "  public void run() { service.work(); }",
        "}",
      ].join("\n")),
    ],
  });

  assert.ok(edge(
    graph,
    "java_method:caller.ImportedCaller#run/0",
    "calls",
    "java_method:com.acme.Container$Service#work/0",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.QualifiedCaller#run/0",
    "calls",
    "java_method:com.acme.Container$Service#work/0",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.Container#run/0",
    "calls",
    "java_method:com.acme.Container$Service#work/0",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.Container$Client#run/0",
    "calls",
    "java_method:com.acme.Container$Service#work/0",
  ));
  assert.ok(edge(
    graph,
    "java_method:caller.WildcardCaller#run/0",
    "calls",
    "java_method:com.acme.Container$Service#work/0",
  ));
  assert.equal(graph.edges.some((candidate) => candidate.type === "calls"
    && candidate.target === "java_method:com.acme.OtherService#work/0"), false);
});

test("materializer resolves calls through inherited superclass and interface member types", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Base.java", "java", [
        "package com.acme;",
        "public class Base {",
        "  public static class Service {",
        "    public void work() {}",
        "  }",
        "}",
      ].join("\n")),
      record("src/com/acme/Child.java", "java", [
        "package com.acme;",
        "public class Child extends Base {",
        "  private Service service;",
        "  public void run() { service.work(); }",
        "}",
      ].join("\n")),
      record("src/com/acme/Contract.java", "java", [
        "package com.acme;",
        "public interface Contract {",
        "  class Service {",
        "    public void work() {}",
        "  }",
        "}",
      ].join("\n")),
      record("src/com/acme/Implementation.java", "java", [
        "package com.acme;",
        "public class Implementation implements Contract {",
        "  private Service service;",
        "  public void run() { service.work(); }",
        "}",
      ].join("\n")),
      record("src/com/acme/OtherService.java", "java", [
        "package com.acme;",
        "public class OtherService {",
        "  public void work() {}",
        "}",
      ].join("\n")),
    ],
  });

  assert.ok(edge(
    graph,
    "java_method:com.acme.Child#run/0",
    "calls",
    "java_method:com.acme.Base$Service#work/0",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.Implementation#run/0",
    "calls",
    "java_method:com.acme.Contract$Service#work/0",
  ));
  assert.equal(graph.edges.some((candidate) => candidate.type === "calls"
    && candidate.target === "java_method:com.acme.OtherService#work/0"), false);
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
        "  public ActionForward audit(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) { return null; }",
        "}",
      ].join("\n")),
    ],
  });

  assert.ok(edge(graph, "page:web/order/edit.jsp", "submits_to", "route:/order/audit.do"));
  assert.ok(edge(graph, "route:/order/audit.do", "dispatches_to", "java_method:com.acme.OrderAction#audit/4"));
});

test("static link query parameters select Struts DispatchAction methods", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("web/order.jsp", "jsp", '<a href="/order.do?method=delete&id=7">Delete</a>', "markup"),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config>",
        "  <action path='/order' type='com.acme.OrderAction' parameter='method'/>",
        "</struts-config>",
      ].join("\n"), "config"),
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction extends DispatchAction {",
        "  public ActionForward delete(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) { return null; }",
        "}",
      ].join("\n")),
    ],
  });
  const route = graph.nodes.find((node) => node.id === "route:/order.do");

  assert.deepEqual(route.data.requestHints[0].parameters, { method: "delete", id: "7" });
  assert.ok(edge(graph, "route:/order.do", "dispatches_to", "java_method:com.acme.OrderAction#delete/4"));
});

test("materializer preserves every form observation when one page submits to one route", () => {
  const jsp = [
    '<form action="/order.do" method="post">',
    '  <input name="method" value="save">',
    '</form>',
    '<form action="/order.do" method="get">',
    '  <input name="method" value="list">',
    '</form>',
  ].join("\n");

  const graph = materializeRecords({
    projectRoot,
    records: [record("web/order.jsp", "jsp", jsp, "markup")],
  });
  const route = graph.nodes.find((node) => node.id === "route:/order.do");
  const submissions = graph.edges.filter((candidate) => (
    candidate.source === "page:web/order.jsp"
      && candidate.type === "submits_to"
      && candidate.target === route.id
  ));

  assert.deepEqual(route.data.requestHints.map(({ method, parameters }) => ({ method, parameters })), [
    { method: "POST", parameters: { method: "save" } },
    { method: "GET", parameters: { method: "list" } },
  ]);
  assert.equal(submissions.length, 1, "repeated forms remain one logical page-to-route relationship");
  assert.deepEqual(submissions[0].evidence.map(({ file, line }) => ({ file, line })), [
    { file: "web/order.jsp", line: 1 },
    { file: "web/order.jsp", line: 4 },
  ]);
});

test("materializer keeps legacy single-form bytes while retaining empty parameters for multiple forms", () => {
  const single = materializeRecords({
    projectRoot,
    records: [record("web/single.jsp", "jsp", [
      '<form action="/single.do">',
      '  <input name="known" value="yes">',
      '  <input name="blank">',
      '</form>',
    ].join("\n"), "markup")],
  });
  const singleRoute = single.nodes.find((node) => node.id === "route:/single.do");
  const singlePage = single.nodes.find((node) => node.id === "page:web/single.jsp");

  assert.deepEqual(singleRoute.data.requestHints[0].parameters, { known: "yes" });
  assert.deepEqual(singlePage.data.fields, ["known", "blank"]);

  const multiple = materializeRecords({
    projectRoot,
    records: [record("web/multiple.jsp", "jsp", [
      '<form action="/first.do"><input name="first"></form>',
      '<form action="/second.do"><input name="second"></form>',
    ].join("\n"), "markup")],
  });
  const first = multiple.nodes.find((node) => node.id === "route:/first.do");
  const second = multiple.nodes.find((node) => node.id === "route:/second.do");

  assert.deepEqual(first.data.requestHints[0].parameters, { first: "" });
  assert.deepEqual(second.data.requestHints[0].parameters, { second: "" });

  const unresolved = materializeRecords({
    projectRoot,
    records: [record("web/unresolved.jsp", "jsp", [
      '<form action="/known.do"><input name="known"></form>',
      '<form action="${dynamic.action}"><input name="dynamic"></form>',
    ].join("\n"), "markup")],
  });
  const known = unresolved.nodes.find((node) => node.id === "route:/known.do");

  assert.deepEqual(known.data.requestHints[0].parameters, { known: "" });
  assert.equal(known.data.requestHints[0].parametersComplete, true);
});

test("materializer retains a static parameter name when its JSP default is runtime-derived", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record(
      "web/order.jsp",
      "jsp",
      '<form action="/order.do"><input name="orderId" value="${order.id}"></form>',
      "markup",
    )],
  });
  const route = graph.nodes.find((node) => node.id === "route:/order.do");
  const model = buildDocumentModel(graph);

  assert.deepEqual(route.data.requestHints[0].parameters, { orderId: "" });
  assert.deepEqual(model.useCases[0].request.parameters, ["orderId"]);
});

test("materializer retains a select parameter when its selected option body is runtime-derived", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record(
      "web/order.jsp",
      "jsp",
      '<form action="/order.do"><select name="status"><option selected><c:out value="${status}"/></option></select></form>',
      "markup",
    )],
  });
  const route = graph.nodes.find((node) => node.id === "route:/order.do");
  const model = buildDocumentModel(graph);

  assert.deepEqual(route.data.requestHints[0].parameters, { status: "" });
  assert.deepEqual(model.useCases[0].request.parameters, ["status"]);
});

test("materializer never publishes a sibling static value for a runtime-derived parameter", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/repeated.jsp", "jsp", [
      '<form action="/text.do">',
      '  <input name="mode" value="${runtimeMode}">',
      '  <input name="mode" value="fixed">',
      '</form>',
      '<form action="/choice.do">',
      '  <input type="checkbox" checked name="flag" value="%{runtimeFlag}">',
      '  <input type="checkbox" checked name="flag" value="fixed">',
      '</form>',
    ].join("\n"), "markup")],
  });
  const textRoute = graph.nodes.find((node) => node.id === "route:/text.do");
  const choiceRoute = graph.nodes.find((node) => node.id === "route:/choice.do");

  assert.deepEqual(textRoute.data.requestHints[0].parameters, { mode: "" });
  assert.deepEqual(choiceRoute.data.requestHints[0].parameters, { flag: "" });
  assert.doesNotMatch(JSON.stringify(graph), /runtimeValueParameterNames|runtimeMode|runtimeFlag/u);
});

test("materializer keeps dynamic field-name uncertainty scoped to its owning form", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/dynamic-fields.jsp", "jsp", [
      '<form action="/dynamic.do"><input name="${runtimeName}"></form>',
      '<form action="/known.do"><input name="known"></form>',
    ].join("\n"), "markup")],
  });
  const dynamicRoute = graph.nodes.find((node) => node.id === "route:/dynamic.do");
  const knownRoute = graph.nodes.find((node) => node.id === "route:/known.do");
  const model = buildDocumentModel(graph);
  const dynamicUseCase = model.useCases.find(({ route }) => route === "/dynamic.do");
  const knownUseCase = model.useCases.find(({ route }) => route === "/known.do");

  assert.deepEqual(dynamicRoute.data.requestHints[0].parameters, {});
  assert.equal(dynamicRoute.data.requestHints[0].parametersComplete, false);
  assert.equal(dynamicRoute.data.requestHints[0].hasDynamicParameterNames, true);
  assert.equal(knownRoute.data.requestHints[0].parametersComplete, true);
  assert.equal(Object.hasOwn(knownRoute.data.requestHints[0], "hasDynamicParameterNames"), false);
  assert.equal(dynamicUseCase.request.hasDynamicParameterNames, true);
  assert.deepEqual(dynamicUseCase.inputs, []);
  assert.deepEqual(knownUseCase.inputs, ["known"]);
});

test("materializer keeps dynamic query-name uncertainty on its owning form", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/query-fields.jsp", "jsp", [
      '<form action="/dynamic.do?${runtimeName}=x&fixed=1"></form>',
      '<form action="/known.do?mode=list"></form>',
    ].join("\n"), "markup")],
  });
  const dynamicRoute = graph.nodes.find((node) => node.id === "route:/dynamic.do");
  const knownRoute = graph.nodes.find((node) => node.id === "route:/known.do");

  assert.deepEqual(dynamicRoute.data.requestHints[0].parameters, { fixed: "1" });
  assert.equal(dynamicRoute.data.requestHints[0].parametersComplete, false);
  assert.equal(dynamicRoute.data.requestHints[0].hasDynamicParameterNames, true);
  assert.equal(knownRoute.data.requestHints[0].parametersComplete, true);
  assert.equal(Object.hasOwn(knownRoute.data.requestHints[0], "hasDynamicParameterNames"), false);
});

test("materializer preserves explicit query parameter names with dynamic values", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record(
      "web/order.jsp",
      "jsp",
      '<form action="/orders.do?method=${bean.method}"></form>',
      "markup",
    )],
  });
  const route = graph.nodes.find((node) => node.id === "route:/orders.do");

  assert.deepEqual(route.data.requestHints[0].parameters, { method: "" });
});

test("single-form empty query values do not hide blank form inputs from use cases", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record(
      "web/login.jsp",
      "jsp",
      '<form action="/login.do?mode=" method="post"><input name="username"></form>',
      "markup",
    )],
  });
  const route = graph.nodes.find((node) => node.id === "route:/login.do");
  const model = buildDocumentModel(graph);

  assert.deepEqual(route.data.requestHints[0].parameters, { mode: "" });
  assert.equal(route.data.requestHints[0].parametersComplete, false);
  assert.deepEqual(model.useCases[0].inputs, ["username", "mode"]);
});

test("included single-form fields remain scoped to their request evidence", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("web/top.jsp", "jsp", [
        '<jsp:include page="/fragment.jsp"/>',
        '<jsp:include page="/sibling.jsp"/>',
      ].join("\n"), "markup"),
      record(
        "web/fragment.jsp",
        "jsp",
        '<form action="login.do?mode=" method="post"><input name="username"></form>',
        "markup",
      ),
      record("web/sibling.jsp", "jsp", '<input name="unrelated">', "markup"),
    ],
  });
  const route = graph.nodes.find((node) => node.id === "route:/login.do");
  const model = buildDocumentModel(graph);

  assert.ok(edge(graph, "page:web/top.jsp", "submits_to", route.id));
  assert.deepEqual(route.data.requestHints[0].parameters, { mode: "" });
  assert.equal(route.data.requestHints[0].parametersComplete, false);
  assert.deepEqual(graph.nodes.find(({ id }) => id === "page:web/top.jsp").data.fields, []);
  assert.deepEqual(graph.nodes.find(({ id }) => id === "page:web/fragment.jsp").data.fields, ["username"]);
  assert.deepEqual(model.useCases[0].inputs, ["username", "mode"]);
});

test("included mixed legacy hints recover each form from its own evidence", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("web/top.jsp", "jsp", [
        '<jsp:include page="/a.jsp"/>',
        '<jsp:include page="/b.jsp"/>',
      ].join("\n"), "markup"),
      record(
        "web/a.jsp",
        "jsp",
        '<form action="save.do?mode="><input name="first"></form>',
        "markup",
      ),
      record(
        "web/b.jsp",
        "jsp",
        '<form action="save.do"><input name="second"></form>',
        "markup",
      ),
    ],
  });
  const route = graph.nodes.find((node) => node.id === "route:/save.do");
  const submission = edge(graph, "page:web/top.jsp", "submits_to", route.id);
  const model = buildDocumentModel(graph);

  assert.deepEqual(route.data.requestHints.map((hint) => ({
    parameters: hint.parameters,
    completeness: Object.hasOwn(hint, "parametersComplete") ? hint.parametersComplete : "legacy",
  })), [
    { parameters: { mode: "" }, completeness: false },
    { parameters: {}, completeness: "legacy" },
  ]);
  assert.deepEqual(submission.evidence.map(({ file }) => file), ["web/a.jsp", "web/b.jsp"]);
  assert.deepEqual(model.useCases[0].inputs, ["first", "second", "mode"]);
});

test("materializer locates explicit query names at the request evidence column", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record(
      "web/order.jsp",
      "jsp",
      '<a href="?other=1">x</a><form action="/orders.do?method=${bean.method}&flag="></form>',
      "markup",
    )],
  });
  const route = graph.nodes.find((node) => node.id === "route:/orders.do");

  assert.deepEqual(route.data.requestHints[0].parameters, { method: "", flag: "" });
});

test("materializer marks one form's parameters complete when page fields remain outside it", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/scoped.jsp", "jsp", [
      '<form action="/scoped.do"><input name="inside"></form>',
      '<input name="outside">',
    ].join("\n"), "markup")],
  });
  const route = graph.nodes.find((node) => node.id === "route:/scoped.do");

  assert.deepEqual(route.data.requestHints[0].parameters, { inside: "" });
  assert.equal(route.data.requestHints[0].parametersComplete, true);
});

test("unsuccessful controls stay out of materialized use-case inputs", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [record("web/controls.jsp", "jsp", [
      '<form action="/dispatch.do">',
      '  <button name="method" value="save">Save</button>',
      '  <button name="method" value="delete">Delete</button>',
      '  <input type="reset" name="reset" value="yes">',
      '  <input type="button" name="plain" value="yes">',
      '  <input disabled name="disabled" value="yes">',
      '</form>',
    ].join("\n"), "markup")],
  });
  const route = graph.nodes.find((node) => node.id === "route:/dispatch.do");
  const model = buildDocumentModel(graph);

  assert.deepEqual(route.data.requestHints[0].parameters, { method: "" });
  assert.equal(route.data.requestHints[0].parametersComplete, true);
  assert.deepEqual(model.useCases[0].inputs, ["method"]);
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

test("materializer distinguishes code-returned outcomes from configured candidates", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/OrderAction.java",
        "java",
        [
          "package com.acme;",
          "public class OrderAction {",
          "  public ActionForward execute(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) {",
          "    return mapping.findForward(\"success\");",
          "  }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts-config.xml",
        "xml",
        [
          "<struts-config><action-mappings>",
          "  <action path='/order/save' type='com.acme.OrderAction'>",
          "    <forward name='success' path='/order/success.jsp'/>",
          "    <forward name='error' path='/order/error.jsp'/>",
          "  </action>",
          "</action-mappings></struts-config>",
        ].join("\n"),
        "config",
      ),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/error.jsp", "jsp", "<p>Error</p>", "markup"),
    ],
  });

  const confirmed = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );
  const candidate = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/error.jsp",
  );

  assert.deepEqual(confirmed.data.outcome, {
    framework: "struts1",
    name: "success",
    classification: "code-confirmed",
    codeEvidence: [{
      file: "src/com/acme/OrderAction.java",
      line: 4,
      column: 5,
      snippet: 'return mapping.findForward("success");',
    }],
  });
  assert.deepEqual(candidate.data.outcome, {
    framework: "struts1",
    name: "error",
    classification: "configured-candidate",
    codeEvidence: [],
  });
  assert.equal(confirmed.confidence, 1, "edge confidence describes exact configuration extraction");
  assert.equal(candidate.confidence, 1, "candidate modality must not overload extraction confidence");
});

test("an unnamed Struts result cannot become code-confirmed", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        '  public ActionForward execute(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) { return mapping.findForward(""); }',
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });

  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );
  assert.deepEqual(outcome.data.outcome, {
    framework: "struts1",
    name: "",
    classification: "configured-candidate",
    codeEvidence: [],
  });
});

test("Struts 2 literal returns confirm only the matching configured result", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/ReviewAction.java",
        "java",
        [
          "package com.acme;",
          "public class ReviewAction {",
          "  public String save() { return \"success\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/review'>",
          "  <action name='save' class='com.acme.ReviewAction' method='save'>",
          "    <result name='success'>/review/success.jsp</result>",
          "    <result name='input'>/review/input.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record("web/review/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/review/input.jsp", "jsp", "<p>Input</p>", "markup"),
    ],
  });

  assert.equal(
    edge(graph, "route:/review/save.action", "forwards_to", "page:web/review/success.jsp")
      .data.outcome.classification,
    "code-confirmed",
  );
  assert.equal(
    edge(graph, "route:/review/save.action", "forwards_to", "page:web/review/input.jsp")
      .data.outcome.classification,
    "configured-candidate",
  );
});

test("a Spring controller sharing a route cannot confirm an unresolved Struts outcome", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/OtherController.java", "java", [
        "package com.acme;",
        "public class OtherController {",
        '  public String handleRequest() { return "success"; }',
        "}",
      ].join("\n")),
      record("WEB-INF/struts.xml", "xml", [
        "<struts><package namespace='/order'>",
        "  <action name='save' class='com.acme.MissingAction'>",
        "    <result name='success'>/order/success.jsp</result>",
        "  </action>",
        "</package></struts>",
      ].join("\n"), "config"),
      record("WEB-INF/applicationContext.xml", "xml", [
        "<beans>",
        "  <bean id='otherController' class='com.acme.OtherController'/>",
        "  <bean class='org.springframework.web.servlet.handler.SimpleUrlHandlerMapping'>",
        "    <property name='mappings'><props>",
        "      <prop key='/order/save.action'>otherController</prop>",
        "    </props></property>",
        "  </bean>",
        "</beans>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });

  assert.ok(edge(
    graph,
    "route:/order/save.action",
    "dispatches_to",
    "java_method:com.acme.OtherController#handleRequest/0",
  ));
  const outcome = edge(
    graph,
    "route:/order/save.action",
    "forwards_to",
    "page:web/order/success.jsp",
  );
  assert.deepEqual(outcome.data.outcome, {
    framework: "struts2",
    name: "success",
    classification: "configured-candidate",
    codeEvidence: [],
  });
});

test("an anonymous-class return cannot confirm its enclosing Struts action outcome", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        "  public ActionForward execute(ActionMapping mapping, ActionForm form,",
        "      HttpServletRequest request, HttpServletResponse response) {",
        '    Callback callback = new Callback() { public ActionForward execute(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) { return mapping.findForward("success"); } };',
        "    return fallback;",
        "  }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(outcome.data.outcome.classification, "configured-candidate");
  assert.deepEqual(outcome.data.outcome.codeEvidence, []);
});

test("a nonstandard Struts 1 method signature cannot confirm an action outcome", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        '  public ActionForward execute(ActionMapping mapping) { return mapping.findForward("success"); }',
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(
    graph.edges.some((candidate) => candidate.source === "route:/order/save.do"
      && candidate.type === "dispatches_to"),
    false,
  );
  assert.equal(outcome.data.outcome.classification, "configured-candidate");
  assert.deepEqual(outcome.data.outcome.codeEvidence, []);
});

test("a local class cannot satisfy a top-level Struts action mapping", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Container.java", "java", [
        "package com.acme;",
        "public class Container {",
        "  public void install() {",
        "    class OrderAction {",
        "      public ActionForward execute(ActionMapping mapping, ActionForm form,",
        "          HttpServletRequest request, HttpServletResponse response) {",
        '        return mapping.findForward("success");',
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(
    graph.edges.some((candidate) => candidate.source === "route:/order/save.do"
      && candidate.type === "maps_to"),
    false,
  );
  assert.equal(outcome.data.outcome.classification, "configured-candidate");
});

test("a fully qualified Struts target cannot fall back to another package", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/other/OrderAction.java", "java", [
        "package other;",
        "public class OrderAction {",
        "  public ActionForward execute(ActionMapping mapping, ActionForm form,",
        "      HttpServletRequest request, HttpServletResponse response) {",
        '    return mapping.findForward("success");',
        "  }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(
    graph.edges.some((candidate) => candidate.source === "route:/order/save.do"
      && candidate.type === "maps_to"),
    false,
  );
  assert.equal(outcome.data.outcome.classification, "configured-candidate");
  assert.deepEqual(outcome.data.outcome.codeEvidence, []);
});

test("an exact public static member class can satisfy a Struts action mapping", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Container.java", "java", [
        "package com.acme;",
        "public class Container {",
        "  public static",
        "  class OrderAction {",
        "    public ActionForward execute(ActionMapping mapping, ActionForm form,",
        "        HttpServletRequest request, HttpServletResponse response) {",
        '      return mapping.findForward("success");',
        "    }",
        "  }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.Container$OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.ok(edge(
    graph,
    "route:/order/save.do",
    "maps_to",
    "java_type:com.acme.Container$OrderAction",
  ));
  assert.ok(edge(
    graph,
    "route:/order/save.do",
    "dispatches_to",
    "java_method:com.acme.Container$OrderAction#execute/4",
  ));
  assert.equal(outcome.data.outcome.classification, "code-confirmed");
});

test("annotation text cannot make a non-static member class a Struts action", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Container.java", "java", [
        "package com.acme;",
        "public class Container {",
        '  @SuppressWarnings("static") public class OrderAction {',
        "    public ActionForward execute(ActionMapping mapping, ActionForm form,",
        "        HttpServletRequest request, HttpServletResponse response) {",
        '      return mapping.findForward("success");',
        "    }",
        "  }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.Container$OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(
    graph.edges.some((candidate) => candidate.source === "route:/order/save.do"
      && candidate.type === "maps_to"),
    false,
  );
  assert.equal(outcome.data.outcome.classification, "configured-candidate");
});

test("a local class cannot satisfy an inherited Struts entry lookup", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/Container.java", "java", [
        "package com.acme;",
        "public class Container {",
        "  public void install() {",
        "    class BaseAction {",
        "      public ActionForward execute(ActionMapping mapping, ActionForm form,",
        "          HttpServletRequest request, HttpServletResponse response) {",
        '        return mapping.findForward("success");',
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n")),
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction extends BaseAction {}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(
    graph.edges.some((candidate) => candidate.source === "route:/order/save.do"
      && candidate.type === "dispatches_to"),
    false,
  );
  assert.equal(outcome.data.outcome.classification, "configured-candidate");
});

test("duplicate Java method records cannot code-confirm a Struts outcome", () => {
  const signature = "ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response";
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/a/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        `  public ActionForward execute(${signature}) { return fallback; }`,
        "}",
      ].join("\n")),
      record("src/z/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction {",
        `  public ActionForward execute(${signature}) { return mapping.findForward("success"); }`,
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/order/save.do",
    "forwards_to",
    "page:web/order/success.jsp",
  );

  assert.equal(outcome.data.outcome.classification, "configured-candidate");
  assert.deepEqual(outcome.data.outcome.codeEvidence, []);
});

test("a parameterized Struts 2 method cannot confirm an action outcome", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/ReviewAction.java", "java", [
        "package com.acme;",
        "public class ReviewAction {",
        '  public String save(String input) { return "success"; }',
        "}",
      ].join("\n")),
      record("WEB-INF/struts.xml", "xml", [
        "<struts><package namespace='/review'>",
        "  <action name='save' class='com.acme.ReviewAction' method='save'>",
        "    <result name='success'>/review/success.jsp</result>",
        "  </action>",
        "</package></struts>",
      ].join("\n"), "config"),
      record("web/review/success.jsp", "jsp", "<p>Saved</p>", "markup"),
    ],
  });
  const outcome = edge(
    graph,
    "route:/review/save.action",
    "forwards_to",
    "page:web/review/success.jsp",
  );

  assert.equal(
    graph.edges.some((candidate) => candidate.source === "route:/review/save.action"
      && candidate.type === "dispatches_to"),
    false,
  );
  assert.equal(outcome.data.outcome.classification, "configured-candidate");
  assert.deepEqual(outcome.data.outcome.codeEvidence, []);
});

test("non-public Struts entry methods do not dispatch or code-confirm outcomes", () => {
  const cases = [
    {
      label: "Struts 1 private execute",
      routeId: "route:/private/save.do",
      pageId: "page:web/private/success.jsp",
      records: [
        record("src/com/acme/PrivateAction.java", "java", [
          "package com.acme;",
          "public class PrivateAction {",
          "  private ActionForward execute(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) {",
          '    return mapping.findForward("success");',
          "  }",
          "}",
        ].join("\n")),
        record("WEB-INF/struts-config.xml", "xml", [
          "<struts-config><action-mappings>",
          "  <action path='/private/save' type='com.acme.PrivateAction'>",
          "    <forward name='success' path='/private/success.jsp'/>",
          "  </action>",
          "</action-mappings></struts-config>",
        ].join("\n"), "config"),
        record("web/private/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      ],
    },
    {
      label: "Struts 2 protected method",
      routeId: "route:/protected/save.action",
      pageId: "page:web/protected/success.jsp",
      records: [
        record("src/com/acme/ProtectedAction.java", "java", [
          "package com.acme;",
          "public class ProtectedAction {",
          '  protected String save() { return "success"; }',
          "}",
        ].join("\n")),
        record("WEB-INF/struts.xml", "xml", [
          "<struts><package namespace='/protected'>",
          "  <action name='save' class='com.acme.ProtectedAction' method='save'>",
          "    <result name='success'>/protected/success.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"), "config"),
        record("web/protected/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      ],
    },
  ];

  for (const scenario of cases) {
    const graph = materializeRecords({ projectRoot, records: scenario.records });
    assert.equal(
      graph.edges.some((candidate) => candidate.source === scenario.routeId
        && candidate.type === "dispatches_to"),
      false,
      scenario.label,
    );
    const outcome = edge(graph, scenario.routeId, "forwards_to", scenario.pageId);
    assert.equal(outcome.data.outcome.classification, "configured-candidate", scenario.label);
    assert.deepEqual(outcome.data.outcome.codeEvidence, [], scenario.label);
  }
});

test("multiple Struts targets sharing one route keep their outcomes as candidates", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("src/com/acme/FirstAction.java", "java", [
        "package com.acme;",
        "public class FirstAction {",
        '  public String save() { return "success"; }',
        "}",
      ].join("\n")),
      record("src/com/acme/SecondAction.java", "java", [
        "package com.acme;",
        "public class SecondAction {",
        '  public String save() { return "success"; }',
        "}",
      ].join("\n")),
      record("WEB-INF/struts.xml", "xml", [
        "<struts><package namespace='/order'>",
        "  <action name='save' class='com.acme.FirstAction' method='save'>",
        "    <result name='success'>/order/first.jsp</result>",
        "  </action>",
        "  <action name='save' class='com.acme.SecondAction' method='save'>",
        "    <result name='success'>/order/second.jsp</result>",
        "  </action>",
        "</package></struts>",
      ].join("\n"), "config"),
      record("web/order/first.jsp", "jsp", "<p>First</p>", "markup"),
      record("web/order/second.jsp", "jsp", "<p>Second</p>", "markup"),
    ],
  });

  const outcomes = graph.edges
    .filter((candidate) => candidate.source === "route:/order/save.action"
      && candidate.type === "forwards_to")
    .map((candidate) => candidate.data.outcome);
  assert.equal(outcomes.length, 2);
  assert.deepEqual(
    outcomes.map(({ classification }) => classification),
    ["configured-candidate", "configured-candidate"],
  );
  assert.ok(outcomes.every(({ codeEvidence }) => codeEvidence.length === 0));
});

test("multiple resolved dispatch methods keep every configured outcome as a candidate", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("web/order/edit.jsp", "jsp", [
        '<html:form action="/order/save" method="post">',
        '  <html:hidden property="method" value="save" />',
        "</html:form>",
        '<html:form action="/order/save" method="post">',
        '  <html:hidden property="method" value="cancel" />',
        "</html:form>",
      ].join("\n"), "markup"),
      record("src/com/acme/OrderAction.java", "java", [
        "package com.acme;",
        "public class OrderAction extends DispatchAction {",
        "  public ActionForward save(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) {",
        "    return mapping.findForward(\"success\");",
        "  }",
        "  public ActionForward cancel(ActionMapping mapping, ActionForm form, HttpServletRequest request, HttpServletResponse response) {",
        "    return mapping.findForward(\"cancelled\");",
        "  }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts-config.xml", "xml", [
        "<struts-config><action-mappings>",
        "  <action path='/order/save' type='com.acme.OrderAction' parameter='method'>",
        "    <forward name='success' path='/order/success.jsp'/>",
        "    <forward name='cancelled' path='/order/cancelled.jsp'/>",
        "  </action>",
        "</action-mappings></struts-config>",
      ].join("\n"), "config"),
    ],
  });

  const classifications = graph.edges
    .filter((candidate) => candidate.source === "route:/order/save.do"
      && candidate.type === "forwards_to")
    .map((candidate) => candidate.data.outcome.classification);
  assert.deepEqual(classifications, ["configured-candidate", "configured-candidate"]);
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
        "  public String perform() { return \"unrelated\"; }",
        "}",
      ].join("\n")),
      record("WEB-INF/struts.xml", "xml", "<struts><package namespace='/order'><action name='save' class='com.acme.OrderAction'/></package></struts>", "config"),
    ],
  });
  const dispatch = edge(graph, "route:/order/save.action", "dispatches_to", "java_method:com.acme.OrderAction#execute/0");
  assert.ok(dispatch);
  assert.equal(dispatch.confidence, 0.9);
  assert.equal(
    edge(graph, "route:/order/save.action", "dispatches_to", "java_method:com.acme.OrderAction#perform/0"),
    undefined,
  );
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

test("Struts 2 tags disambiguate duplicate action names only with an explicit namespace", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts>",
          "  <constant name='struts.action.extension' value='html'/>",
          "  <package namespace='/admin'><action name='save' class='com.acme.AdminSaveAction'/></package>",
          "  <package namespace='/order'><action name='save' class='com.acme.OrderSaveAction'/></package>",
          "</struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/WEB-INF/pages/edit.jsp",
        "jsp",
        [
          "<s:form action='save' namespace='/admin' method='post'></s:form>",
          "<s:form action='save' namespace='/order' method='post'></s:form>",
          "<s:form action='save' method='post'></s:form>",
        ].join("\n"),
        "markup",
      ),
    ],
  });

  const page = "page:web/WEB-INF/pages/edit.jsp";
  assert.ok(edge(graph, page, "submits_to", "route:/admin/save.html"));
  assert.ok(edge(graph, page, "submits_to", "route:/order/save.html"));
  assert.ok(edge(graph, page, "submits_to", "route:/save.action"));
  assert.equal(edge(graph, page, "submits_to", "route:/admin/save.action"), undefined);
  assert.equal(edge(graph, page, "submits_to", "route:/order/save.action"), undefined);
});

test("relative native forms reconcile to one uniquely configured Struts 2 action", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts>",
          "  <constant name='struts.action.extension' value='html'/>",
          "  <package namespace='/'>",
          "    <action name='search' class='com.acme.SearchAction'><result>/WEB-INF/pages/search.jsp</result></action>",
          "    <action name='printPreviewDisplay' class='com.acme.PrintPreviewAction'/>",
          "  </package>",
          "  <package namespace='/admin'>",
          "    <action name='openSearch' class='com.acme.SearchAction'><result>/WEB-INF/pages/search.jsp</result></action>",
          "  </package>",
          "</struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/WEB-INF/pages/search.jsp",
        "jsp",
        '<form action="printPreviewDisplay.html" method="post"><input name="patientId"></form>',
        "markup",
      ),
    ],
  });

  assert.ok(edge(
    graph,
    "page:web/WEB-INF/pages/search.jsp",
    "submits_to",
    "route:/printPreviewDisplay.html",
  ));
  assert.equal(
    graph.nodes.some((node) => node.id === "route:/admin/printPreviewDisplay.html"),
    false,
  );
});

test("Struts 2 dynamic method requests align to the configured route and dispatch method", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/SaveAction.java",
        "java",
        [
          "package com.acme;",
          "public class SaveAction {",
          "  public String execute() { return \"success\"; }",
          "  public String approve() { return \"approved\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/order'>",
          "  <action name='save' class='com.acme.SaveAction'>",
          "    <result name='success'>/order/success.jsp</result>",
          "    <result name='approved'>/order/approved.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        '<form action="/order/save!approve.action" method="post"></form>',
        "markup",
      ),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/approved.jsp", "jsp", "<p>Approved</p>", "markup"),
    ],
  });

  const routeId = "route:/order/save.action";
  assert.ok(edge(graph, "page:web/order/edit.jsp", "submits_to", routeId));
  assert.equal(graph.nodes.some((node) => node.id === "route:/order/save!approve.action"), false);
  assert.ok(edge(graph, routeId, "dispatches_to", "java_method:com.acme.SaveAction#approve/0"));
  assert.equal(edge(graph, routeId, "dispatches_to", "java_method:com.acme.SaveAction#execute/0"), undefined);

  const route = graph.nodes.find((node) => node.id === routeId);
  assert.deepEqual(route.data.requestHints.map(({ dispatchMethod }) => dispatchMethod), ["approve"]);
  const outcomes = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "forwards_to")
    .map((candidate) => [candidate.data.outcome.name, candidate.data.outcome.classification]);
  assert.deepEqual(outcomes, [
    ["approved", "code-confirmed"],
    ["success", "configured-candidate"],
  ]);
});

test("Struts 2 dynamic methods override an explicitly configured action method", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/SaveAction.java",
        "java",
        [
          "package com.acme;",
          "public class SaveAction {",
          "  public String save() { return \"saved\"; }",
          "  public String approve() { return \"approved\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/order'>",
          "  <action name='save' class='com.acme.SaveAction' method='save'>",
          "    <result name='saved'>/order/saved.jsp</result>",
          "    <result name='approved'>/order/approved.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        '<form action="/order/save!approve.action" method="post"></form>',
        "markup",
      ),
      record("web/order/saved.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/approved.jsp", "jsp", "<p>Approved</p>", "markup"),
    ],
  });

  const routeId = "route:/order/save.action";
  assert.ok(edge(graph, routeId, "dispatches_to", "java_method:com.acme.SaveAction#approve/0"));
  assert.equal(edge(graph, routeId, "dispatches_to", "java_method:com.acme.SaveAction#save/0"), undefined);
  const outcomes = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "forwards_to")
    .map((candidate) => [candidate.data.outcome.name, candidate.data.outcome.classification]);
  assert.deepEqual(outcomes, [
    ["approved", "code-confirmed"],
    ["saved", "configured-candidate"],
  ]);
});

test("ordinary and dynamic Struts 2 requests retain configured and request-specific methods", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/SaveAction.java",
        "java",
        [
          "package com.acme;",
          "public class SaveAction {",
          "  public String save() { return \"saved\"; }",
          "  public String approve() { return \"approved\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/order'>",
          "  <action name='save' class='com.acme.SaveAction' method='save'>",
          "    <result name='saved'>/order/saved.jsp</result>",
          "    <result name='approved'>/order/approved.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        [
          '<form action="/order/save.action" method="post"></form>',
          '<form action="/order/save!approve.action" method="post"></form>',
        ].join("\n"),
        "markup",
      ),
      record("web/order/saved.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/approved.jsp", "jsp", "<p>Approved</p>", "markup"),
    ],
  });

  const routeId = "route:/order/save.action";
  const dispatches = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "dispatches_to")
    .map((candidate) => candidate.target);
  assert.deepEqual(dispatches, [
    "java_method:com.acme.SaveAction#approve/0",
    "java_method:com.acme.SaveAction#save/0",
  ]);
  assert.ok(
    graph.edges
      .filter((candidate) => candidate.source === routeId && candidate.type === "forwards_to")
      .every((candidate) => candidate.data.outcome.classification === "configured-candidate"),
  );
});

test("ordinary and dynamic Struts 2 requests preserve both possible dispatch methods", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/SaveAction.java",
        "java",
        [
          "package com.acme;",
          "public class SaveAction {",
          "  public String execute() { return \"success\"; }",
          "  public String approve() { return \"approved\"; }",
          "  public String perform() { return \"unrelated\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/order'>",
          "  <action name='save' class='com.acme.SaveAction'>",
          "    <result name='success'>/order/success.jsp</result>",
          "    <result name='approved'>/order/approved.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        [
          '<form action="/order/save.action" method="post"></form>',
          '<form action="/order/save!approve.action" method="post"></form>',
        ].join("\n"),
        "markup",
      ),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/approved.jsp", "jsp", "<p>Approved</p>", "markup"),
    ],
  });

  const routeId = "route:/order/save.action";
  const dispatches = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "dispatches_to")
    .map((candidate) => candidate.target);
  assert.deepEqual(dispatches, [
    "java_method:com.acme.SaveAction#approve/0",
    "java_method:com.acme.SaveAction#execute/0",
  ]);
  const outcomes = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "forwards_to")
    .map((candidate) => [candidate.data.outcome.name, candidate.data.outcome.classification]);
  assert.deepEqual(outcomes, [
    ["approved", "configured-candidate"],
    ["success", "configured-candidate"],
  ]);
});

test("ordinary and dynamic Struts 2 requests retain an inherited default execute method", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/BaseAction.java",
        "java",
        [
          "package com.acme;",
          "public class BaseAction {",
          "  public String execute() { return \"success\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "src/com/acme/SaveAction.java",
        "java",
        [
          "package com.acme;",
          "public class SaveAction extends BaseAction {",
          "  public String approve() { return \"approved\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/order'>",
          "  <action name='save' class='com.acme.SaveAction'>",
          "    <result name='success'>/order/success.jsp</result>",
          "    <result name='approved'>/order/approved.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        [
          '<form action="/order/save.action" method="post"></form>',
          '<form action="/order/save!approve.action" method="post"></form>',
        ].join("\n"),
        "markup",
      ),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/approved.jsp", "jsp", "<p>Approved</p>", "markup"),
    ],
  });

  const routeId = "route:/order/save.action";
  const dispatches = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "dispatches_to")
    .map((candidate) => candidate.target);
  assert.deepEqual(dispatches, [
    "java_method:com.acme.BaseAction#execute/0",
    "java_method:com.acme.SaveAction#approve/0",
  ]);
  assert.ok(
    graph.edges
      .filter((candidate) => candidate.source === routeId && candidate.type === "forwards_to")
      .every((candidate) => candidate.data.outcome.classification === "configured-candidate"),
  );
});

test("multiple Struts 2 dynamic method hints keep every configured outcome as a candidate", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "src/com/acme/SaveAction.java",
        "java",
        [
          "package com.acme;",
          "public class SaveAction {",
          "  public String execute() { return \"success\"; }",
          "  public String approve() { return \"approved\"; }",
          "  public String reject() { return \"rejected\"; }",
          "}",
        ].join("\n"),
      ),
      record(
        "WEB-INF/struts.xml",
        "xml",
        [
          "<struts><package namespace='/order'>",
          "  <action name='save' class='com.acme.SaveAction'>",
          "    <result name='success'>/order/success.jsp</result>",
          "    <result name='approved'>/order/approved.jsp</result>",
          "    <result name='rejected'>/order/rejected.jsp</result>",
          "  </action>",
          "</package></struts>",
        ].join("\n"),
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        [
          '<form action="/order/save!approve.action" method="post"></form>',
          '<form action="/order/save!reject.action" method="post"></form>',
        ].join("\n"),
        "markup",
      ),
      record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
      record("web/order/approved.jsp", "jsp", "<p>Approved</p>", "markup"),
      record("web/order/rejected.jsp", "jsp", "<p>Rejected</p>", "markup"),
    ],
  });

  const routeId = "route:/order/save.action";
  const route = graph.nodes.find((node) => node.id === routeId);
  assert.deepEqual(
    route.data.requestHints.map(({ dispatchMethod }) => dispatchMethod),
    ["approve", "reject"],
  );
  const dispatches = graph.edges
    .filter((candidate) => candidate.source === routeId && candidate.type === "dispatches_to")
    .map((candidate) => candidate.target);
  assert.deepEqual(dispatches, [
    "java_method:com.acme.SaveAction#approve/0",
    "java_method:com.acme.SaveAction#reject/0",
  ]);
  assert.equal(dispatches.includes("java_method:com.acme.SaveAction#execute/0"), false);
  assert.ok(
    graph.edges
      .filter((candidate) => candidate.source === routeId && candidate.type === "forwards_to")
      .every((candidate) => candidate.data.outcome.classification === "configured-candidate"),
  );
});

test("absolute form and tag paths do not reconcile by Struts 2 action basename", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts.xml",
        "xml",
        "<struts><constant name='struts.action.extension' value='html'/><package namespace='/order'><action name='save' class='com.acme.SaveAction'/></package></struts>",
        "config",
      ),
      record(
        "web/order/edit.jsp",
        "jsp",
        [
          '<form action="/admin/save" method="post"></form>',
          '<s:form action="/elsewhere/save" method="post"></s:form>',
          '<s:form action="save" namespace="/namespaced" method="post"></s:form>',
          '<form action="<c:url value="/admin/save"/>" method="post"></form>',
        ].join("\n"),
        "markup",
      ),
    ],
  });

  assert.ok(edge(graph, "page:web/order/edit.jsp", "submits_to", "route:/admin/save"));
  assert.ok(edge(graph, "page:web/order/edit.jsp", "submits_to", "route:/elsewhere/save.action"));
  assert.ok(edge(graph, "page:web/order/edit.jsp", "submits_to", "route:/namespaced/save.action"));
  assert.equal(
    edge(graph, "page:web/order/edit.jsp", "submits_to", "route:/order/save.html"),
    undefined,
  );
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
    record(
      "WEB-INF/struts.xml",
      "xml",
      "<struts><package namespace='/order'><action name='save' class='saveAction' method='save'><result name='success'>/order/success.jsp</result></action></package></struts>",
      "config",
    ),
    record("web/order/success.jsp", "jsp", "<p>Saved</p>", "markup"),
  ];

  const graph = materializeRecords({ projectRoot, records });

  assert.ok(edge(graph, "route:/order/save.action", "maps_to", "java_type:com.acme.SaveAction"));
  assert.ok(edge(graph, "route:/order/save.action", "dispatches_to", "java_method:com.acme.SaveAction#save/0"));
  const outcome = edge(
    graph,
    "route:/order/save.action",
    "forwards_to",
    "page:web/order/success.jsp",
  );
  assert.equal(outcome.data.outcome.classification, "code-confirmed");
  assert.deepEqual(outcome.data.outcome.codeEvidence, [{
    file: "src/com/acme/SaveAction.java",
    line: 3,
    column: 26,
    snippet: 'public String save() { return "success"; }',
  }]);
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

test("Tiles arrival contexts exclude overridden parent template and put pages", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts-config.xml",
        "xml",
        "<struts-config><action path='/orders/view' type='com.acme.ViewAction'><forward name='view' path='child.page'/></action></struts-config>",
        "config",
      ),
      record("WEB-INF/tiles.xml", "xml", [
        "<tiles-definitions>",
        "  <definition name='base.page' template='/base-template.jsp'>",
        "    <put name='body' value='/old-body.jsp'/>",
        "    <put name='footer' value='/footer.jsp'/>",
        "  </definition>",
        "  <definition name='child.page' extends='base.page' template='/child-template.jsp'>",
        "    <put name='body' value='/new-body.jsp'/>",
        "  </definition>",
        "</tiles-definitions>",
      ].join("\n"), "config"),
      record("web/base-template.jsp", "jsp", '<script>fetch("base-template.do")</script>', "markup"),
      record("web/old-body.jsp", "jsp", '<script>fetch("old-body.do")</script>', "markup"),
      record("web/child-template.jsp", "jsp", '<script>fetch("child-template.do")</script>', "markup"),
      record("web/new-body.jsp", "jsp", '<script>fetch("new-body.do")</script>', "markup"),
      record("web/footer.jsp", "jsp", '<script>fetch("footer.do")</script>', "markup"),
    ],
  });

  for (const name of ["child-template", "new-body", "footer"]) {
    assert.ok(graph.nodes.some(({ id }) => id === `route:/orders/${name}.do`), name);
  }
  for (const name of ["base-template", "old-body"]) {
    assert.equal(graph.nodes.some(({ id }) => id === `route:/orders/${name}.do`), false, name);
  }
});

test("cyclic Tiles inheritance terminates and preserves each effective page once", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record(
        "WEB-INF/struts-config.xml",
        "xml",
        "<struts-config><action path='/cycle/view' type='com.acme.ViewAction'><forward name='view' path='cycle.a'/></action></struts-config>",
        "config",
      ),
      record("WEB-INF/tiles.xml", "xml", [
        "<tiles-definitions>",
        "  <definition name='cycle.a' extends='cycle.b' template='/a.jsp'/>",
        "  <definition name='cycle.b' extends='cycle.a'>",
        "    <put name='body' value='/b.jsp'/>",
        "  </definition>",
        "</tiles-definitions>",
      ].join("\n"), "config"),
      record("web/a.jsp", "jsp", '<script>fetch("from-a.do")</script>', "markup"),
      record("web/b.jsp", "jsp", '<script>fetch("from-b.do")</script>', "markup"),
    ],
  });

  assert.ok(edge(graph, "tiles_definition:cycle.a", "extends_tile", "tiles_definition:cycle.b"));
  assert.ok(edge(graph, "tiles_definition:cycle.b", "extends_tile", "tiles_definition:cycle.a"));
  for (const name of ["from-a", "from-b"]) {
    const requestEdges = graph.edges.filter((candidate) => (
      candidate.type === "requests" && candidate.target === `route:/cycle/${name}.do`
    ));
    assert.equal(requestEdges.length, 1, name);
  }
});

test("Tiles composition handles deep inheritance without recursive stack growth", () => {
  const depth = 5_000;
  const nodeById = new Map();
  const outgoingBySource = new Map();
  for (let index = 0; index < depth; index += 1) {
    const nodeId = `tiles_definition:deep-${index}`;
    nodeById.set(nodeId, { id: nodeId, type: "tiles_definition" });
    if (index + 1 < depth) {
      outgoingBySource.set(nodeId, [{
        id: `extends:${index}`,
        source: nodeId,
        target: `tiles_definition:deep-${index + 1}`,
        type: "extends_tile",
      }]);
    }
  }
  nodeById.set("page:deep.jsp", { id: "page:deep.jsp", type: "page" });
  outgoingBySource.set(`tiles_definition:deep-${depth - 1}`, [{
    id: "puts:body",
    source: `tiles_definition:deep-${depth - 1}`,
    target: "page:deep.jsp",
    type: "puts",
    data: { name: "body" },
  }]);

  const pages = effectiveTilePages("tiles_definition:deep-0", nodeById, outgoingBySource);

  assert.equal(pages.length, 1);
  assert.equal(pages[0].node.id, "page:deep.jsp");
  assert.equal(pages[0].edges.length, depth);
  assert.equal(pages[0].edges[0].id, "extends:0");
  assert.equal(pages[0].edges.at(-1).id, "puts:body");
});
