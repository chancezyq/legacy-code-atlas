import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseJava } from "../src/parsers/java.mjs";

async function javaFixture(relativePath) {
  return readFile(new URL(`./fixtures/legacy-shop/src/${relativePath}`, import.meta.url), "utf8");
}

test("Java parser extracts package, type, inheritance, fields, methods, and calls", async () => {
  const content = await javaFixture("com/acme/order/web/OrderAuditAction.java");
  const result = parseJava(content, "src/com/acme/order/web/OrderAuditAction.java");

  assert.equal(result.packageName, "com.acme.order.web");
  assert.deepEqual(result.imports, [
    "com.acme.order.service.OrderAuditService",
    "org.apache.struts.action.DispatchAction",
  ]);
  assert.deepEqual(result.types.map(({ kind, name, fullName, extendsType }) => [kind, name, fullName, extendsType]), [
    ["class", "OrderAuditAction", "com.acme.order.web.OrderAuditAction", "DispatchAction"],
  ]);
  assert.deepEqual(result.fields.map(({ type, name }) => [type, name]), [["OrderAuditService", "orderAuditService"]]);
  assert.deepEqual(result.methods.map(({ name }) => name), ["setOrderAuditService", "audit"]);
  assert.equal(result.methods[1].parameters.includes("orderId"), false);
  assert.deepEqual(
    result.calls.filter((call) => call.enclosingMethod === "audit").map(({ receiver, method }) => [receiver, method]),
    [
      ["Long", "valueOf"],
      ["request", "getParameter"],
      ["orderAuditService", "audit"],
      ["mapping", "findForward"],
    ],
  );
  assert.equal(result.calls.find((call) => call.method === "audit").evidence.line, 16);
  assert.deepEqual(result.methods[1].returnedResults, [{
    name: "success",
    kind: "struts1-find-forward",
    evidence: {
      file: "src/com/acme/order/web/OrderAuditAction.java",
      line: 17,
      column: 9,
      snippet: 'return mapping.findForward("success");',
    },
  }]);
});

test("Java parser records method visibility", () => {
  const result = parseJava([
    "class VisibilityAction {",
    '  public String publicEntry() { return "public"; }',
    '  protected String protectedEntry() { return "protected"; }',
    '  private String privateEntry() { return "private"; }',
    '  String packageEntry() { return "package"; }',
    "}",
  ].join("\n"), "src/VisibilityAction.java");

  assert.deepEqual(
    result.methods.map(({ name, visibility }) => [name, visibility]),
    [
      ["publicEntry", "public"],
      ["protectedEntry", "protected"],
      ["privateEntry", "private"],
      ["packageEntry", "package"],
    ],
  );
});

test("Java parser records only direct literal action results in their innermost methods", () => {
  const result = parseJava([
    "class ResultAction {",
    "  ActionForward execute(ActionMapping mapping) {",
    "    mapping.findForward(\"calledOnly\");",
    "    return mapping.findForward(\"success\");",
    "  }",
    "  String save(boolean valid, String dynamicResult) {",
    "    // return \"commented\";",
    "    if (valid) return \"saved\";",
    "    return dynamicResult;",
    "  }",
    "  String withLambda() {",
    "    Supplier<String> supplier = () -> { return \"lambda-only\"; };",
    "    return \"input\";",
    "  }",
    "  Object wrongReturnType() { return \"not-an-action-result\"; }",
    "  class Nested {",
    "    String execute() { return \"nested\"; }",
    "  }",
    "}",
  ].join("\n"), "src/ResultAction.java");

  assert.deepEqual(
    result.methods.map(({ ownerType, name, returnedResults }) => ({ ownerType, name, returnedResults })),
    [
      {
        ownerType: "ResultAction",
        name: "execute",
        returnedResults: [{
          name: "success",
          kind: "struts1-find-forward",
          evidence: {
            file: "src/ResultAction.java",
            line: 4,
            column: 5,
            snippet: 'return mapping.findForward("success");',
          },
        }],
      },
      {
        ownerType: "ResultAction",
        name: "save",
        returnedResults: [{
          name: "saved",
          kind: "string-literal",
          evidence: {
            file: "src/ResultAction.java",
            line: 8,
            column: 16,
            snippet: 'if (valid) return "saved";',
          },
        }],
      },
      {
        ownerType: "ResultAction",
        name: "withLambda",
        returnedResults: [{
          name: "input",
          kind: "string-literal",
          evidence: {
            file: "src/ResultAction.java",
            line: 13,
            column: 5,
            snippet: 'return "input";',
          },
        }],
      },
      { ownerType: "ResultAction", name: "wrongReturnType", returnedResults: [] },
      {
        ownerType: "ResultAction$Nested",
        name: "execute",
        returnedResults: [{
          name: "nested",
          kind: "string-literal",
          evidence: {
            file: "src/ResultAction.java",
            line: 17,
            column: 24,
            snippet: 'String execute() { return "nested"; }',
          },
        }],
      },
    ],
  );
});

test("Java parser does not attribute anonymous-class methods to the enclosing type", () => {
  const result = parseJava([
    "package com.acme;",
    "public class OrderAction {",
    "  public ActionForward execute(ActionMapping mapping) {",
    "    Callback callback = new Callback() {",
    "      public ActionForward execute(ActionMapping mapping) {",
    '        return mapping.findForward("success");',
    "      }",
    "    };",
    "    return fallback;",
    "  }",
    "}",
  ].join("\n"), "src/com/acme/OrderAction.java");

  const directMethods = result.methods.filter((method) => method.ownerType === "com.acme.OrderAction");
  const anonymousMethods = result.methods.filter((method) => method.ownerType === "");

  assert.equal(directMethods.length, 1);
  assert.deepEqual(directMethods[0].returnedResults, []);
  assert.equal(anonymousMethods.length, 1);
  assert.deepEqual(anonymousMethods[0].returnedResults, []);
});

test("Java parser keeps compact anonymous-class and lambda facts out of the enclosing method", () => {
  const result = parseJava([
    "package com.acme;",
    "public class OrderAction {",
    "  private SqlMapClient sqlMapClient;",
    "  private Helper helper;",
    "  public ActionForward execute(ActionMapping mapping, ActionForm form,",
    "      HttpServletRequest request, HttpServletResponse response) {",
    '    Handler callback = new Handler() { public ActionForward call() { LocalService nestedService; sqlMapClient.delete("anonymous.delete"); return mapping.findForward("success"); } };',
    "    Handler fields = new Handler() {",
    "      private SqlMapClient anonymousClient;",
    '      static final String STATEMENT_ID = "anonymous.statement";',
    "    };",
    '    Runnable task = () -> { LocalService lambdaService; sqlMapClient.update("lambda.update"); };',
    "    helper.finish();",
    "    return fallback;",
    "  }",
    "}",
  ].join("\n"), "src/com/acme/OrderAction.java");

  const execute = result.methods.find((method) => (
    method.ownerType === "com.acme.OrderAction" && method.name === "execute"
  ));

  assert.deepEqual(result.fields.map(({ name }) => name), ["sqlMapClient", "helper"]);
  assert.deepEqual(result.stringConstants, []);
  assert.deepEqual(
    result.localVariables
      .filter(({ name }) => ["callback", "fields", "task"].includes(name))
      .map(({ name, enclosingMethod }) => [name, enclosingMethod]),
    [["callback", "execute"], ["fields", "execute"], ["task", "execute"]],
  );
  assert.equal(result.localVariables.some(({ name }) => name === "nestedService"), false);
  assert.equal(result.localVariables.some(({ name }) => name === "lambdaService"), false);
  assert.deepEqual(
    result.calls.map(({ receiver, method, enclosingMethod }) => [receiver, method, enclosingMethod]),
    [["helper", "finish", "execute"]],
  );
  assert.deepEqual(result.statementUses, []);
  assert.deepEqual(execute.returnedResults, []);
});

test("Java parser blocks annotated and explicitly generic anonymous-class bodies", () => {
  const result = parseJava([
    "class AnonymousAction {",
    "  private Helper helper;",
    "  void run() {",
    "    Handler annotated = new @Marker Handler() { { helper.annotatedInner(); } };",
    "    Handler generic = new <String> Handler() { { helper.genericInner(); } };",
    "    helper.outer();",
    "  }",
    "}",
  ].join("\n"), "src/AnonymousAction.java");

  assert.deepEqual(
    result.calls.map(({ receiver, method, enclosingMethod }) => [receiver, method, enclosingMethod]),
    [["helper", "outer", "run"]],
  );
});

test("Java parser keeps literal returns from arrow and colon switch branches", () => {
  const result = parseJava([
    "class ResultAction {",
    "  String execute(int code) {",
    "    switch (code) {",
    '      case 1 -> { return "success"; }',
    '      case 2: return "retry";',
    '      case FLAG ? 3 : 4 -> { return "conditional"; }',
    '      default -> { return "input"; }',
    "    }",
    "  }",
    "}",
  ].join("\n"), "src/ResultAction.java");

  assert.deepEqual(
    result.methods[0].returnedResults.map(({ name }) => name),
    ["success", "retry", "conditional", "input"],
  );
});

test("Java parser does not treat a returned switch expression as a nested method", () => {
  const result = parseJava([
    "class ResultAction {",
    "  private Helper helper;",
    "  String execute(int code) {",
    "    return switch (code) {",
    '      case 1 -> { helper.branch(); yield "success"; }',
    '      default -> { helper.fallback(); yield "input"; }',
    "    };",
    "  }",
    "}",
  ].join("\n"), "src/ResultAction.java");

  assert.deepEqual(
    result.methods.map(({ name, ownerType }) => [name, ownerType]),
    [["execute", "ResultAction"]],
  );
  assert.deepEqual(
    result.calls.map(({ receiver, method, enclosingMethod }) => [receiver, method, enclosingMethod]),
    [
      ["helper", "branch", "execute"],
      ["helper", "fallback", "execute"],
    ],
  );
  assert.deepEqual(result.methods[0].returnedResults, []);
});

test("Java parser does not treat an else-if branch as a nested method", () => {
  const result = parseJava([
    "class BranchAction {",
    "  private Helper helper;",
    "  void run(boolean flag) {",
    "    if (flag) { helper.first(); }",
    "    else if (!flag) { helper.second(); }",
    "    helper.after();",
    "  }",
    "}",
  ].join("\n"), "src/BranchAction.java");

  assert.deepEqual(
    result.methods.map(({ name, ownerType }) => [name, ownerType]),
    [["run", "BranchAction"]],
  );
  assert.deepEqual(
    result.calls.map(({ receiver, method, enclosingMethod }) => [receiver, method, enclosingMethod]),
    [
      ["helper", "first", "run"],
      ["helper", "second", "run"],
      ["helper", "after", "run"],
    ],
  );
});

test("Java parser keeps expression-lambda and compact local-class facts out of the outer method", () => {
  const result = parseJava([
    "class LambdaAction {",
    "  private SqlMapClient sqlMapClient;",
    "  private Helper helper;",
    "  void execute() {",
    "    Supplier<Object> first = () -> helper.inner();",
    "    Supplier<Object> second = () -> getDao().load();",
    '    Supplier<Object> third = () -> sqlMapClient.queryForObject("lambda.select");',
    "    Function<Object, Object> fourth = value -> helper.consume(value);",
    '    class Local { void work() { LocalService localService; sqlMapClient.delete("local.delete"); helper.local(); } }',
    "    helper.outer();",
    "  }",
    "}",
  ].join("\n"), "src/LambdaAction.java");

  assert.equal(result.localVariables.some(({ name }) => name === "localService"), false);
  assert.deepEqual(
    result.calls.map(({ receiver, receiverMethod, method }) => [receiver, receiverMethod, method]),
    [["helper", undefined, "outer"]],
  );
  assert.deepEqual(result.statementUses, []);
});

test("Java parser keeps generic constructor expression-lambda facts out of the outer method", () => {
  const result = parseJava([
    "class LambdaAction {",
    "  private Service service;",
    "  private SqlMapClient sqlMapClient;",
    "  private Helper helper;",
    "  void execute() {",
    "    Supplier<Pair<Service, Map<String, Object>>> task = () -> new Pair<Service, Map<String, Object>>(",
    "      service.deferred(),",
    '      sqlMapClient.queryForObject("lambda.select")',
    "    );",
    "    helper.outer();",
    "  }",
    "}",
  ].join("\n"), "src/LambdaAction.java");

  assert.deepEqual(
    result.calls.map(({ receiver, method }) => [receiver, method]),
    [["helper", "outer"]],
  );
  assert.deepEqual(result.statementUses, []);
});

test("Java parser keeps explicit generic method expression-lambda facts out of the outer method", () => {
  const result = parseJava([
    "class LambdaAction {",
    "  private Service service;",
    "  private SqlMapClient sqlMapClient;",
    "  private Helper helper;",
    "  void execute() {",
    "    Supplier<Object> task = () -> helper.<Map<Service, Object>, Other>defer(",
    "      service.deferred(),",
    '      sqlMapClient.queryForObject("lambda.select")',
    "    );",
    "    helper.outer();",
    "  }",
    "}",
  ].join("\n"), "src/LambdaAction.java");

  assert.deepEqual(
    result.calls.map(({ receiver, method }) => [receiver, method]),
    [["helper", "outer"]],
  );
  assert.deepEqual(result.statementUses, []);
});

test("Java parser does not treat lambda comparisons, shifts, or ternaries as generic type arguments", () => {
  const result = parseJava([
    "class LambdaAction {",
    "  private Helper helper;",
    "  void execute() {",
    "    BooleanSupplier compared = () -> left < right;",
    "    IntSupplier shifted = () -> left << right;",
    "    Supplier<Object> selected = () -> flag ? helper.first() : helper.second();",
    "    helper.outer();",
    "  }",
    "}",
  ].join("\n"), "src/LambdaAction.java");

  assert.deepEqual(
    result.calls.map(({ receiver, method }) => [receiver, method]),
    [["helper", "outer"]],
  );
});

test("Java parser distinguishes nested lambdas from their enclosing switch rule", () => {
  const result = parseJava([
    "class SwitchAction {",
    "  private SqlMapClient sqlMapClient;",
    "  private Helper helper;",
    "  String execute(int code) {",
    "    switch (code) {",
    '      case 1 -> helper.run(() -> { sqlMapClient.update("lambda.update"); return "success"; });',
    '      default -> { return "input"; }',
    "    }",
    '    return "fallback";',
    "  }",
    "}",
  ].join("\n"), "src/SwitchAction.java");

  assert.deepEqual(
    result.methods[0].returnedResults.map(({ name }) => name),
    ["input", "fallback"],
  );
  assert.deepEqual(
    result.calls.map(({ receiver, method }) => [receiver, method]),
    [["helper", "run"]],
  );
  assert.deepEqual(result.statementUses, []);
});

test("Java parser classifies only real or implicit static member types as static", () => {
  const result = parseJava([
    "package com.acme;",
    "public class Container {",
    '  @SuppressWarnings("static") public class AnnotatedInner {}',
    "  public static",
    "  class ExplicitStatic {}",
    "  interface MemberContract {}",
    "  enum MemberState { READY }",
    "}",
    "interface Registry {",
    "  class RegisteredAction {}",
    "}",
  ].join("\n"), "src/com/acme/Container.java");

  assert.deepEqual(
    result.types.map(({ fullName, staticMember }) => [fullName, staticMember]),
    [
      ["com.acme.Container", false],
      ["com.acme.Container$AnnotatedInner", false],
      ["com.acme.Container$ExplicitStatic", true],
      ["com.acme.Container$MemberContract", true],
      ["com.acme.Container$MemberState", true],
      ["com.acme.Registry", false],
      ["com.acme.Registry$RegisteredAction", true],
    ],
  );
});

test("Java parser emits source canonical names only for addressable Java types", () => {
  const result = parseJava([
    "package com.acme;",
    "public class Container {",
    "  public static class Service {",
    "    public static class Worker {}",
    "  }",
    "  public void install() { class Local {} }",
    "}",
  ].join("\n"), "src/com/acme/Container.java");

  assert.equal(result.types.find(({ name }) => name === "Container").canonicalName, "com.acme.Container");
  assert.equal(result.types.find(({ name }) => name === "Service").canonicalName, "com.acme.Container.Service");
  assert.equal(result.types.find(({ name }) => name === "Worker").canonicalName, "com.acme.Container.Service.Worker");
  assert.equal(result.types.find(({ name }) => name === "Local").canonicalName, undefined);
});

test("Java parser extracts interface implementation and service-to-DAO calls", async () => {
  const content = await javaFixture("com/acme/order/service/impl/OrderAuditServiceImpl.java");
  const result = parseJava(content, "src/com/acme/order/service/impl/OrderAuditServiceImpl.java");

  assert.deepEqual(result.types[0].implementsTypes, ["OrderAuditService"]);
  assert.deepEqual(result.calls.map(({ receiver, method }) => [receiver, method]), [
    ["orderDao", "updateStatus"],
    ["orderDao", "insertAuditLog"],
  ]);
});

test("Java parser records calls made on no-argument method return values", () => {
  const result = parseJava([
    "package com.acme;",
    "class OrderAction extends BaseAction {",
    "  void execute(CartItem cartItem) {",
    "    getPetStore().updateAccount();",
    "    cartItem.getItem().getItemId();",
    "  }",
    "}",
  ].join("\n"), "src/com/acme/OrderAction.java");

  assert.deepEqual(result.calls.map(({ receiver, receiverMethod, method }) => [receiver, receiverMethod, method]), [
    ["getPetStore", "getPetStore", "updateAccount"],
    ["cartItem", undefined, "getItem"],
  ]);
});

test("Java parser finds iBATIS statement calls and ignores commented calls", async () => {
  const content = await javaFixture("com/acme/order/dao/IbatisOrderDao.java");
  const result = parseJava(content, "src/com/acme/order/dao/IbatisOrderDao.java");

  assert.deepEqual(
    result.statementUses.map(({ operation, statementId, enclosingMethod }) => [operation, statementId, enclosingMethod]),
    [
      ["queryForObject", "order.findForAudit", "findForAudit"],
      ["update", "order.updateStatus", "updateStatus"],
      ["insert", "order.insertAuditLog", "insertAuditLog"],
      ["delete", "order.missingStatement", "unresolvedStatement"],
    ],
  );
  assert.equal(result.statementUses.some((use) => use.statementId === "ignored.fakeStatement"), false);
});

test("Java parser assigns methods, calls, and statement uses to the containing type", () => {
  const content = `package multi;\nclass First {\n  private Helper first;\n  void run() { first.one(); }\n}\nclass Second {\n  private SqlMapClient sqlMapClient;\n  void run() { sqlMapClient.update("second.update", this); }\n}\n`;
  const result = parseJava(content, "src/multi/Multi.java");

  assert.deepEqual(result.methods.map(({ name, ownerType }) => [name, ownerType]), [
    ["run", "multi.First"],
    ["run", "multi.Second"],
  ]);
  assert.deepEqual(result.calls.map(({ method, ownerType }) => [method, ownerType]), [
    ["one", "multi.First"],
    ["update", "multi.Second"],
  ]);
  assert.deepEqual(result.statementUses.map(({ statementId, ownerType }) => [statementId, ownerType]), [
    ["second.update", "multi.Second"],
  ]);
});

test("Java parser does not treat unrelated update methods as iBATIS statements", () => {
  const content = `class AuditService {\n  private AuditLogger auditLogger;\n  void run() { auditLogger.update("not.an.ibatis.statement"); }\n}`;
  const result = parseJava(content, "AuditService.java");

  assert.deepEqual(result.statementUses, []);
});

test("Java parser resolves variable statement IDs from class constants", () => {
  const content = `class LegacyDao {\n  static final String STATEMENT_ID = "orders.find";\n  static final String STATEMENT_ID_FALLBACK = "find";\n  private SqlMapClient sqlMapClient;\n  private String statementId;\n  LegacyDao(SqlMapClient client) { this(client, STATEMENT_ID); }\n  LegacyDao(SqlMapClient client, String statementId) { this.sqlMapClient=client; this.statementId=statementId; }\n  void load() { sqlMapClient.queryForList(statementId, null); }\n}`;
  const result = parseJava(content, "LegacyDao.java");

  assert.deepEqual(
    result.statementUses.map(({ statementId, resolution, confidence }) => [statementId, resolution, confidence]),
    [
      ["orders.find", "class-constant-candidate", 0.7],
      ["find", "class-constant-candidate", 0.7],
    ],
  );
});

test("Java parser handles generic return types with whitespace before resolving statement fields", () => {
  const content = `class GenericDao {
  static final String STATEMENT_ID = "orders.find";
  private SqlMapClient sqlMapClient;
  private String statementId;
  public HashMap<String, Boolean> load(List<String> ids) throws SQLException {
    Map<String, Object> params = new HashMap<String, Object>();
    return (HashMap<String, Boolean>) sqlMapClient.queryForList(statementId, params);
  }
}`;

  const result = parseJava(content, "GenericDao.java");

  assert.equal(result.methods.some((method) => method.name === "load"), true);
  assert.deepEqual(result.fields.map((field) => field.name), ["sqlMapClient", "statementId"]);
  assert.deepEqual(
    result.statementUses.map(({ statementId, enclosingMethod }) => [statementId, enclosingMethod]),
    [["orders.find", "load"]],
  );
});

test("Java parser extracts local receiver declarations inside their methods", () => {
  const content = `package com.acme;
class LocalCaller {
  void execute() {
    OrderService service = lookupService();
    java.util.Map<String, Object> attributes = loadAttributes();
    service.audit();
  }
}`;

  const result = parseJava(content, "src/com/acme/LocalCaller.java");

  assert.deepEqual(
    result.localVariables.map(({ type, name, ownerType, enclosingMethod }) => [type, name, ownerType, enclosingMethod]),
    [
      ["OrderService", "service", "com.acme.LocalCaller", "execute"],
      ["java.util.Map<String,Object>", "attributes", "com.acme.LocalCaller", "execute"],
    ],
  );
  assert.equal(result.localVariables[0].evidence.line, 4);
});

test("Java parser does not turn control-flow statements into local declarations", () => {
  const result = parseJava([
    "class Caller {",
    "  void execute(boolean stop) {",
    "    Service service = lookupService();",
    "    if (stop) return service;",
    "    if (stop) throw failure;",
    "    switch (state) { case READY, WAITING -> use(); default -> { yield service; } }",
    "    service.call();",
    "  }",
    "}",
  ].join("\n"), "src/Caller.java");

  assert.deepEqual(
    result.localVariables.map(({ type, name }) => [type, name]),
    [["Service", "service"]],
  );
});

test("Java parser records enclosing arity for overloaded method facts", () => {
  const content = `class Overloaded {
  void execute() {
    FirstService service;
    service.audit();
  }
  void execute(java.util.Map<String, Order> orders) {
    SqlMapClient sqlMapClient;
    SecondService service;
    sqlMapClient.update("order.update", orders);
    service.audit();
  }
}`;

  const result = parseJava(content, "src/Overloaded.java");

  assert.deepEqual(
    result.localVariables.map(({ name, enclosingMethodArity }) => [name, enclosingMethodArity]),
    [["service", 0], ["sqlMapClient", 1], ["service", 1]],
  );
  assert.deepEqual(
    result.calls.filter(({ method }) => method === "audit").map(({ enclosingMethodArity }) => enclosingMethodArity),
    [0, 1],
  );
  assert.deepEqual(
    result.statementUses.map(({ statementId, enclosingMethodArity }) => [statementId, enclosingMethodArity]),
    [["order.update", 1]],
  );
});

test("Java parser records parameter signatures for same-arity overloads", () => {
  const result = parseJava(`class SameArity {
  void execute(String value) { FirstService service; service.audit(); }
  void execute(Integer value) { SecondService service; service.audit(); }
}`, "src/SameArity.java");

  assert.deepEqual(result.methods.map(({ name, parameters, parameterTypes, methodSignature }) => [name, parameters, parameterTypes, methodSignature]), [
    ["execute", ["value"], ["String"], "String"],
    ["execute", ["value"], ["Integer"], "Integer"],
  ]);
  assert.deepEqual(result.localVariables.map(({ name, enclosingMethodSignature }) => [name, enclosingMethodSignature]), [
    ["service", "String"],
    ["service", "Integer"],
  ]);
});

test("Java parser handles parameter annotations with comma-separated values", () => {
  const result = parseJava(`class Annotated {
  void run(@Bind({A, B}) String value, int count) {
    Helper helper;
    helper.process();
  }
}`, "src/Annotated.java");

  assert.deepEqual(result.methods.map(({ name, parameters, parameterTypes, methodSignature }) => [name, parameters, parameterTypes, methodSignature]), [
    ["run", ["value", "count"], ["String", "int"], "String,int"],
  ]);
  assert.deepEqual(result.localVariables.map(({ name, enclosingMethodSignature }) => [name, enclosingMethodSignature]), [
    ["helper", "String,int"],
  ]);
  assert.deepEqual(result.calls.map(({ receiver, method, enclosingMethodSignature }) => [receiver, method, enclosingMethodSignature]), [
    ["helper", "process", "String,int"],
  ]);
});
