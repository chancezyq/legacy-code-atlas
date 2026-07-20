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
