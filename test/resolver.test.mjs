import assert from "node:assert/strict";
import test from "node:test";

import { GraphBuilder } from "../src/graph.mjs";
import { buildResolverIndexes } from "../src/resolver-indexes.mjs";
import { resolveFacts } from "../src/resolver.mjs";

function method(graph, type, name, arity, line, methodSignature = "") {
  const node = graph.addNode({
    type: "java_method",
    key: `${type.fullName}#${name}/${arity}${methodSignature ? `(${methodSignature})` : ""}`,
    name: `${type.name}.${name}`,
    evidence: [{ file: `${type.name}.java`, line, column: 1, snippet: `${name}()` }],
  });
  return { name, arity, methodSignature, node, evidence: node.evidence[0] };
}

function type(graph, fullName, methods = [], extra = {}) {
  const name = fullName.split(".").at(-1);
  const node = graph.addNode({ type: "java_type", key: fullName, name });
  return {
    fullName,
    name,
    node,
    methods: methods.map(({ name: methodName, arity, line = 1, signature = "" }) => method(graph, { fullName, name }, methodName, arity, line, signature)),
    implementsTypes: [],
    extendsType: "",
    ...extra,
  };
}

function javaFile(types, overrides = {}) {
  return {
    packageName: "com.acme",
    imports: [],
    fields: [],
    localVariables: [],
    calls: [],
    statementUses: [],
    types,
    ...overrides,
  };
}

test("resolver indexes preserve duplicate full IDs, simple-name order, and owner buckets", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const first = type(graph, "com.one.Service", [{ name: "run", arity: 0, line: 1 }]);
  const second = type(graph, "com.two.Service", [{ name: "run", arity: 1, line: 2 }]);
  const replacement = type(graph, "com.one.Service", [{ name: "run", arity: 2, line: 3 }]);
  const firstFile = javaFile([first], {
    fields: [{ ownerType: first.fullName, name: "dao", type: "com.acme.Dao" }],
    calls: [{ ownerType: first.fullName, receiver: "dao", method: "run", enclosingMethod: "caller", evidence: { file: "First.java", line: 8, column: 1, snippet: "dao.run()" } }],
    statementUses: [{ ownerType: first.fullName, statementId: "one.select", enclosingMethod: "caller", operation: "query", evidence: { file: "First.java", line: 9, column: 1, snippet: "one.select" } }],
  });
  const secondFile = javaFile([second]);
  const replacementFile = javaFile([replacement]);
  const statementFirst = { id: "select", fullId: "one.select", node: graph.addNode({ type: "statement", key: "one.select", name: "one.select" }) };
  const statementSecond = { id: "select", fullId: "two.select", node: graph.addNode({ type: "statement", key: "two.select", name: "two.select" }) };

  const indexes = buildResolverIndexes(graph, {
    javaFiles: [firstFile, secondFile, replacementFile],
    statements: [statementFirst, statementSecond],
    routeTargets: [],
  });

  assert.equal(indexes.typesByFull.get("com.one.Service")[0], replacement);
  assert.deepEqual(indexes.typesBySimple.get("Service"), [first, second, replacement]);
  assert.deepEqual(indexes.methodsByName.get("run").map((candidate) => candidate.arity), [0, 1, 2]);
  assert.deepEqual(indexes.methodsByTypeAndName.get(`${first.node.id}|run`).map((candidate) => candidate.arity), [2]);
  assert.deepEqual(indexes.fieldsByOwner.get(first.fullName).map((field) => field.name), ["dao"]);
  assert.deepEqual(indexes.callsByOwner.get(first.fullName).map((call) => call.method), ["run"]);
  assert.deepEqual(indexes.statementUsesByOwner.get(first.fullName).map((use) => use.statementId), ["one.select"]);
  assert.equal(indexes.statementsByFull.get("one.select"), statementFirst);
  assert.deepEqual(indexes.statementsByShort.get("select"), [statementFirst, statementSecond]);
});

test("resolver keeps interface arity and unique-method heuristic semantics", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const contract = type(graph, "com.acme.Contract", [
    { name: "save", arity: 1, line: 1 },
    { name: "save", arity: 2, line: 2 },
  ]);
  const implementation = type(graph, "com.acme.Impl", [
    { name: "save", arity: 1, line: 10 },
    { name: "save", arity: 3, line: 11 },
  ], { implementsTypes: ["Contract"] });
  const caller = type(graph, "com.acme.Caller", [
    { name: "call", arity: 0, line: 20 },
  ]);
  const target = type(graph, "com.acme.Target", [
    { name: "unique", arity: 0, line: 30 },
  ]);
  const callerFile = javaFile([caller], {
    fields: [],
    calls: [{ ownerType: caller.fullName, receiver: "missing", method: "unique", enclosingMethod: "call", evidence: { file: "Caller.java", line: 21, column: 1, snippet: "missing.unique()" } }],
  });
  const facts = {
    javaFiles: [javaFile([contract]), javaFile([implementation]), callerFile, javaFile([target])],
    statements: [],
    routeTargets: [],
  };

  resolveFacts(graph, facts);

  const interfaceEdges = [...graph.edges.values()].filter((edge) => edge.type === "implemented_by");
  assert.equal(interfaceEdges.some((edge) => edge.source === contract.methods[0].node.id && edge.target === implementation.methods[0].node.id), true);
  assert.equal(interfaceEdges.some((edge) => edge.source === contract.methods[1].node.id && edge.target === implementation.methods[1].node.id), false);
  const callEdges = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.equal(callEdges.length, 1);
  assert.equal(callEdges[0].target, target.methods[0].node.id);
  assert.equal(callEdges[0].confidence, 0.5);
  assert.equal(callEdges[0].reason, "unique method-name heuristic");
});

test("resolver uses canonical member-type imports without global member fallback", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const member = type(graph, "com.acme.Container$Service", [
    { name: "work", arity: 0, line: 1 },
  ], {
    name: "Service",
    canonicalName: "com.acme.Container.Service",
    topLevel: false,
    staticMember: true,
  });
  const unrelated = type(graph, "com.other.OtherService", [
    { name: "work", arity: 0, line: 2 },
  ]);
  const caller = type(graph, "caller.Caller", [
    { name: "run", arity: 0, line: 3 },
  ]);
  const callerFile = javaFile([caller], {
    packageName: "caller",
    imports: ["com.acme.Container.Service"],
    fields: [{ ownerType: caller.fullName, name: "service", type: "Service" }],
    calls: [{
      ownerType: caller.fullName,
      receiver: "service",
      method: "work",
      enclosingMethod: "run",
      evidence: { file: "Caller.java", line: 4, column: 1, snippet: "service.work()" },
    }],
  });
  const facts = {
    javaFiles: [javaFile([member]), javaFile([unrelated]), callerFile],
    statements: [],
    routeTargets: [],
  };

  const indexes = buildResolverIndexes(graph, facts);
  assert.deepEqual(indexes.typesByCanonical.get(member.canonicalName), [member]);

  resolveFacts(graph, facts);

  const callEdges = [...graph.edges.values()].filter((candidate) => candidate.type === "calls");
  assert.deepEqual(callEdges.map(({ source, target }) => [source, target]), [[
    caller.methods[0].node.id,
    member.methods[0].node.id,
  ]]);
});

test("resolver qualifies member types from the imported enclosing type", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const container = type(graph, "com.acme.Container", [], {
    canonicalName: "com.acme.Container",
    topLevel: true,
  });
  const member = type(graph, "com.acme.Container$Service", [
    { name: "work", arity: 0, line: 1 },
  ], {
    name: "Service",
    canonicalName: "com.acme.Container.Service",
    topLevel: false,
    staticMember: true,
  });
  const unrelated = type(graph, "com.other.Service", [
    { name: "work", arity: 0, line: 2 },
  ], {
    canonicalName: "com.other.Service",
    topLevel: true,
  });
  const caller = type(graph, "caller.Caller", [
    { name: "run", arity: 0, line: 3 },
  ]);
  const callerFile = javaFile([caller], {
    packageName: "caller",
    imports: ["com.acme.Container", "com.other.Service"],
    fields: [{ ownerType: caller.fullName, name: "service", type: "Container.Service" }],
    calls: [{
      ownerType: caller.fullName,
      receiver: "service",
      method: "work",
      enclosingMethod: "run",
      evidence: { file: "Caller.java", line: 4, column: 1, snippet: "service.work()" },
    }],
  });

  resolveFacts(graph, {
    javaFiles: [javaFile([container, member]), javaFile([unrelated]), callerFile],
    statements: [],
    routeTargets: [],
  });

  const callEdges = [...graph.edges.values()].filter((candidate) => candidate.type === "calls");
  assert.deepEqual(callEdges.map(({ source, target }) => [source, target]), [[
    caller.methods[0].node.id,
    member.methods[0].node.id,
  ]]);
});

test("resolver finds member types through lexical owners and type wildcard imports", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const container = type(graph, "com.acme.Container", [
    { name: "run", arity: 0, line: 1 },
  ], { canonicalName: "com.acme.Container", topLevel: true });
  const client = type(graph, "com.acme.Container$Client", [
    { name: "run", arity: 0, line: 2 },
  ], {
    name: "Client",
    canonicalName: "com.acme.Container.Client",
    topLevel: false,
    staticMember: true,
  });
  const service = type(graph, "com.acme.Container$Service", [
    { name: "work", arity: 0, line: 3 },
  ], {
    name: "Service",
    canonicalName: "com.acme.Container.Service",
    topLevel: false,
    staticMember: true,
  });
  const unrelated = type(graph, "com.other.OtherService", [
    { name: "work", arity: 0, line: 4 },
  ]);
  const wildcardCaller = type(graph, "caller.WildcardCaller", [
    { name: "run", arity: 0, line: 5 },
  ]);
  const containerFile = javaFile([container, client, service], {
    fields: [
      { ownerType: container.fullName, name: "service", type: "Service" },
      { ownerType: client.fullName, name: "service", type: "Service" },
    ],
    calls: [
      { ownerType: container.fullName, receiver: "service", method: "work", enclosingMethod: "run", evidence: { file: "Container.java", line: 6, column: 1, snippet: "service.work()" } },
      { ownerType: client.fullName, receiver: "service", method: "work", enclosingMethod: "run", evidence: { file: "Container.java", line: 7, column: 1, snippet: "service.work()" } },
    ],
  });
  const wildcardFile = javaFile([wildcardCaller], {
    packageName: "caller",
    imports: ["com.acme.Container.*"],
    fields: [{ ownerType: wildcardCaller.fullName, name: "service", type: "Service" }],
    calls: [{ ownerType: wildcardCaller.fullName, receiver: "service", method: "work", enclosingMethod: "run", evidence: { file: "WildcardCaller.java", line: 6, column: 1, snippet: "service.work()" } }],
  });

  resolveFacts(graph, {
    javaFiles: [containerFile, javaFile([unrelated]), wildcardFile],
    statements: [],
    routeTargets: [],
  });

  const callEdges = [...graph.edges.values()].filter((candidate) => candidate.type === "calls");
  assert.deepEqual(callEdges.map(({ source, target }) => [source, target]), [
    [container.methods[0].node.id, service.methods[0].node.id],
    [client.methods[0].node.id, service.methods[0].node.id],
    [wildcardCaller.methods[0].node.id, service.methods[0].node.id],
  ]);
});

test("resolver finds member types inherited from superclasses and interfaces", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const base = type(graph, "com.acme.Base", [], {
    canonicalName: "com.acme.Base",
    topLevel: true,
  });
  const baseService = type(graph, "com.acme.Base$Service", [
    { name: "work", arity: 0, line: 1 },
  ], {
    name: "Service",
    canonicalName: "com.acme.Base.Service",
    topLevel: false,
    staticMember: true,
  });
  const child = type(graph, "com.acme.Child", [
    { name: "run", arity: 0, line: 2 },
  ], {
    canonicalName: "com.acme.Child",
    topLevel: true,
    extendsType: "Base",
  });
  const contract = type(graph, "com.acme.Contract", [], {
    kind: "interface",
    canonicalName: "com.acme.Contract",
    topLevel: true,
  });
  const contractService = type(graph, "com.acme.Contract$Service", [
    { name: "work", arity: 0, line: 3 },
  ], {
    name: "Service",
    canonicalName: "com.acme.Contract.Service",
    topLevel: false,
    staticMember: true,
  });
  const implementation = type(graph, "com.acme.Implementation", [
    { name: "run", arity: 0, line: 4 },
  ], {
    canonicalName: "com.acme.Implementation",
    topLevel: true,
    implementsTypes: ["Contract"],
  });
  const unrelated = type(graph, "com.other.OtherService", [
    { name: "work", arity: 0, line: 5 },
  ]);
  const childFile = javaFile([child], {
    fields: [{ ownerType: child.fullName, name: "service", type: "Service" }],
    calls: [{ ownerType: child.fullName, receiver: "service", method: "work", enclosingMethod: "run", evidence: { file: "Child.java", line: 6, column: 1, snippet: "service.work()" } }],
  });
  const implementationFile = javaFile([implementation], {
    fields: [{ ownerType: implementation.fullName, name: "service", type: "Service" }],
    calls: [{ ownerType: implementation.fullName, receiver: "service", method: "work", enclosingMethod: "run", evidence: { file: "Implementation.java", line: 7, column: 1, snippet: "service.work()" } }],
  });

  resolveFacts(graph, {
    javaFiles: [
      javaFile([base, baseService]),
      childFile,
      javaFile([contract, contractService]),
      implementationFile,
      javaFile([unrelated]),
    ],
    statements: [],
    routeTargets: [],
  });

  const callEdges = [...graph.edges.values()].filter((candidate) => candidate.type === "calls");
  assert.deepEqual(callEdges.map(({ source, target }) => [source, target]), [
    [child.methods[0].node.id, baseService.methods[0].node.id],
    [implementation.methods[0].node.id, contractService.methods[0].node.id],
  ]);
});

test("resolver checks inherited member types at each enclosing lexical scope", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const baseOne = type(graph, "com.acme.BaseOne", [], {
    canonicalName: "com.acme.BaseOne",
    topLevel: true,
  });
  const baseOneService = type(graph, "com.acme.BaseOne$Service", [
    { name: "workOne", arity: 0, line: 1 },
  ], {
    name: "Service",
    canonicalName: "com.acme.BaseOne.Service",
    topLevel: false,
    staticMember: true,
  });
  const outerOne = type(graph, "com.acme.OuterOne", [], {
    canonicalName: "com.acme.OuterOne",
    topLevel: true,
    extendsType: "BaseOne",
  });
  const innerOne = type(graph, "com.acme.OuterOne$Inner", [
    { name: "run", arity: 0, line: 2 },
  ], {
    name: "Inner",
    canonicalName: "com.acme.OuterOne.Inner",
    topLevel: false,
  });
  const otherOne = type(graph, "com.other.OtherOne", [
    { name: "workOne", arity: 0, line: 3 },
  ]);

  const baseTwo = type(graph, "com.acme.BaseTwo", [], {
    canonicalName: "com.acme.BaseTwo",
    topLevel: true,
  });
  const baseTwoService = type(graph, "com.acme.BaseTwo$Service", [
    { name: "workTwo", arity: 0, line: 4 },
  ], {
    name: "Service",
    canonicalName: "com.acme.BaseTwo.Service",
    topLevel: false,
    staticMember: true,
  });
  const outerTwo = type(graph, "com.acme.OuterTwo", [], {
    canonicalName: "com.acme.OuterTwo",
    topLevel: true,
  });
  const outerTwoService = type(graph, "com.acme.OuterTwo$Service", [
    { name: "workTwo", arity: 0, line: 5 },
  ], {
    name: "Service",
    canonicalName: "com.acme.OuterTwo.Service",
    topLevel: false,
    staticMember: true,
  });
  const innerTwo = type(graph, "com.acme.OuterTwo$Inner", [
    { name: "run", arity: 0, line: 6 },
  ], {
    name: "Inner",
    canonicalName: "com.acme.OuterTwo.Inner",
    topLevel: false,
    extendsType: "BaseTwo",
  });

  const outerOneFile = javaFile([outerOne, innerOne], {
    fields: [{ ownerType: innerOne.fullName, name: "service", type: "Service" }],
    calls: [{
      ownerType: innerOne.fullName,
      receiver: "service",
      method: "workOne",
      enclosingMethod: "run",
      evidence: { file: "OuterOne.java", line: 7, column: 1, snippet: "service.workOne()" },
    }],
  });
  const outerTwoFile = javaFile([outerTwo, outerTwoService, innerTwo], {
    fields: [{ ownerType: innerTwo.fullName, name: "service", type: "Service" }],
    calls: [{
      ownerType: innerTwo.fullName,
      receiver: "service",
      method: "workTwo",
      enclosingMethod: "run",
      evidence: { file: "OuterTwo.java", line: 8, column: 1, snippet: "service.workTwo()" },
    }],
  });

  resolveFacts(graph, {
    javaFiles: [
      javaFile([baseOne, baseOneService]),
      outerOneFile,
      javaFile([otherOne], { packageName: "com.other" }),
      javaFile([baseTwo, baseTwoService]),
      outerTwoFile,
    ],
    statements: [],
    routeTargets: [],
  });

  const callEdges = [...graph.edges.values()].filter((candidate) => candidate.type === "calls");
  assert.deepEqual(callEdges.map(({ source, target }) => [source, target]), [
    [innerOne.methods[0].node.id, baseOneService.methods[0].node.id],
    [innerTwo.methods[0].node.id, baseTwoService.methods[0].node.id],
  ]);
});

test("resolver excludes the current class body when resolving its supertype header", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/child", name: "/child" });
  const base = type(graph, "p.Base", [
    { name: "execute", arity: 0, line: 1 },
  ], {
    canonicalName: "p.Base",
    topLevel: true,
  });
  const baseService = type(graph, "p.Base$Service", [
    { name: "work", arity: 0, line: 2 },
  ], {
    name: "Service",
    canonicalName: "p.Base.Service",
    topLevel: false,
    staticMember: true,
  });
  const child = type(graph, "p.Child", [
    { name: "run", arity: 0, line: 3 },
  ], {
    canonicalName: "p.Child",
    topLevel: true,
    extendsType: "Base",
  });
  const shadowingBase = type(graph, "p.Child$Base", [], {
    name: "Base",
    canonicalName: "p.Child.Base",
    topLevel: false,
    staticMember: true,
  });
  const shadowingService = type(graph, "p.Child$Base$Service", [
    { name: "work", arity: 0, line: 4 },
  ], {
    name: "Service",
    canonicalName: "p.Child.Base.Service",
    topLevel: false,
    staticMember: true,
  });
  const childFile = javaFile([child, shadowingBase, shadowingService], {
    packageName: "p",
    fields: [{ ownerType: child.fullName, name: "service", type: "Service" }],
    calls: [{
      ownerType: child.fullName,
      receiver: "service",
      method: "work",
      enclosingMethod: "run",
      evidence: { file: "Child.java", line: 4, column: 1, snippet: "service.work()" },
    }],
  });

  resolveFacts(graph, {
    javaFiles: [
      javaFile([base, baseService], { packageName: "p" }),
      childFile,
    ],
    statements: [],
    routeTargets: [{
      routeNode: route,
      targetClass: child.fullName,
      source: "Struts action mapping",
      evidence: { file: "struts.xml", line: 1, column: 1, snippet: "child" },
    }],
  });

  const callEdges = [...graph.edges.values()].filter((candidate) => candidate.type === "calls");
  assert.deepEqual(callEdges.map(({ source, target }) => [source, target]), [[
    child.methods[0].node.id,
    baseService.methods[0].node.id,
  ]]);
  const dispatches = [...graph.edges.values()].filter((candidate) => candidate.type === "dispatches_to");
  assert.deepEqual(dispatches.map(({ target }) => target), [base.methods[0].node.id]);
});

test("resolver excludes the implementing class body when resolving its interface header", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const contract = type(graph, "p.Contract", [
    { name: "save", arity: 0, line: 1 },
  ], {
    kind: "interface",
    canonicalName: "p.Contract",
    topLevel: true,
  });
  const implementation = type(graph, "p.Implementation", [
    { name: "save", arity: 0, line: 2 },
  ], {
    canonicalName: "p.Implementation",
    topLevel: true,
    implementsTypes: ["Contract"],
  });
  const shadowingContract = type(graph, "p.Implementation$Contract", [], {
    kind: "interface",
    name: "Contract",
    canonicalName: "p.Implementation.Contract",
    topLevel: false,
    staticMember: true,
  });

  resolveFacts(graph, {
    javaFiles: [
      javaFile([contract], { packageName: "p" }),
      javaFile([implementation, shadowingContract], { packageName: "p" }),
    ],
    statements: [],
    routeTargets: [],
  });

  const relations = [...graph.edges.values()].filter((edge) => edge.type === "implements");
  assert.deepEqual(relations.map(({ source, target }) => [source, target]), [[
    implementation.node.id,
    contract.node.id,
  ]]);
  const methodRelations = [...graph.edges.values()].filter((edge) => (
    edge.type === "implemented_by" && edge.source.startsWith("java_method:")
  ));
  assert.deepEqual(methodRelations.map(({ source, target }) => [source, target]), [[
    contract.methods[0].node.id,
    implementation.methods[0].node.id,
  ]]);
});

test("resolver matches same-arity interface overloads by parameter signature", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const contract = type(graph, "com.acme.Contract", [
    { name: "save", arity: 1, signature: "String", line: 1 },
    { name: "save", arity: 1, signature: "Integer", line: 2 },
  ]);
  const implementation = type(graph, "com.acme.Impl", [
    { name: "save", arity: 1, signature: "java.lang.String", line: 10 },
    { name: "save", arity: 1, signature: "java.lang.Integer", line: 11 },
  ], { implementsTypes: ["Contract"] });

  resolveFacts(graph, {
    javaFiles: [javaFile([contract]), javaFile([implementation])],
    statements: [],
    routeTargets: [],
  });

  const methodEdges = [...graph.edges.values()].filter((edge) => edge.type === "implemented_by"
    && edge.source.startsWith("java_method:"));
  assert.deepEqual(methodEdges.map((edge) => [edge.source, edge.target]), [
    [contract.methods[0].node.id, implementation.methods[0].node.id],
    [contract.methods[1].node.id, implementation.methods[1].node.id],
  ]);
});

test("resolver scopes source methods to the current duplicate type record", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const first = type(graph, "com.acme.Duplicate", [{ name: "caller", arity: 0, line: 1 }]);
  const replacement = type(graph, "com.acme.Duplicate", [{ name: "replacementOnly", arity: 0, line: 2 }]);
  const target = type(graph, "com.acme.Target", [{ name: "only", arity: 0, line: 3 }]);
  const firstFile = javaFile([first], {
    calls: [{ ownerType: first.fullName, receiver: "missing", method: "only", enclosingMethod: "caller", evidence: { file: "Duplicate.java", line: 4, column: 1, snippet: "missing.only()" } }],
  });

  resolveFacts(graph, {
    javaFiles: [firstFile, javaFile([replacement]), javaFile([target])],
    statements: [],
    routeTargets: [],
  });

  const calls = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, first.methods[0].node.id);
  assert.equal(calls[0].target, target.methods[0].node.id);
});

test("resolver preserves explicit-import, same-package, and ambiguous simple-name priority", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const contractA = type(graph, "com.a.Contract");
  const contractB = type(graph, "com.b.Contract");
  const explicit = type(graph, "com.impl.Explicit", [], { implementsTypes: ["Contract"] });
  const samePackage = type(graph, "com.b.SamePackage", [], { implementsTypes: ["Contract"] });
  const ambiguous = type(graph, "com.other.Ambiguous", [], { implementsTypes: ["Contract"] });

  resolveFacts(graph, {
    javaFiles: [
      javaFile([contractA], { packageName: "com.a" }),
      javaFile([contractB], { packageName: "com.b" }),
      javaFile([explicit], { packageName: "com.impl", imports: ["com.a.Contract"] }),
      javaFile([samePackage], { packageName: "com.b" }),
      javaFile([ambiguous], { packageName: "com.other" }),
    ],
    statements: [],
    routeTargets: [],
  });

  const relations = [...graph.edges.values()].filter((edge) => edge.type === "implements");
  assert.deepEqual(
    relations.filter((edge) => edge.source === explicit.node.id).map((edge) => edge.target),
    [contractA.node.id],
  );
  assert.deepEqual(
    relations.filter((edge) => edge.source === samePackage.node.id).map((edge) => edge.target),
    [contractB.node.id],
  );
  assert.deepEqual(
    relations.filter((edge) => edge.source === ambiguous.node.id).map((edge) => edge.target),
    [contractA.node.id, contractB.node.id],
  );
  assert.equal(relations.find((edge) => edge.source === ambiguous.node.id)?.confidence, 0.5);
});

test("resolver does not apply owner facts from a different Java file", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const caller = type(graph, "com.acme.Caller", [{ name: "call", arity: 0, line: 1 }]);
  const unrelated = type(graph, "com.acme.Unrelated", [{ name: "other", arity: 0, line: 2 }]);
  const target = type(graph, "com.acme.Target", [{ name: "unique", arity: 0, line: 3 }]);
  const misplacedCall = {
    ownerType: caller.fullName,
    receiver: "missing",
    method: "unique",
    enclosingMethod: "call",
    evidence: { file: "Unrelated.java", line: 4, column: 1, snippet: "missing.unique()" },
  };

  resolveFacts(graph, {
    javaFiles: [javaFile([caller]), javaFile([unrelated], { calls: [misplacedCall] }), javaFile([target])],
    statements: [],
    routeTargets: [],
  });

  assert.deepEqual([...graph.edges.values()].filter((edge) => edge.type === "calls"), []);
});

test("resolver uses the last duplicate type record for receiver targets", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const firstService = type(graph, "com.acme.Service", [{ name: "run", arity: 0, line: 1 }]);
  const replacementService = type(graph, "com.acme.Service", [{ name: "run", arity: 1, line: 2 }]);
  const caller = type(graph, "com.acme.Caller", [{ name: "call", arity: 0, line: 3 }]);
  const callerFile = javaFile([caller], {
    fields: [{ ownerType: caller.fullName, name: "service", type: "com.acme.Service" }],
    calls: [{ ownerType: caller.fullName, receiver: "service", method: "run", enclosingMethod: "call", evidence: { file: "Caller.java", line: 4, column: 1, snippet: "service.run()" } }],
  });

  resolveFacts(graph, {
    javaFiles: [javaFile([firstService]), javaFile([replacementService]), callerFile],
    statements: [],
    routeTargets: [],
  });

  const calls = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, replacementService.methods[0].node.id);
});

test("resolver keeps fields and statement uses scoped to each Java file", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const firstCaller = type(graph, "com.acme.Caller", [{ name: "call", arity: 0, line: 1 }]);
  const secondCaller = type(graph, "com.acme.Caller", [{ name: "call", arity: 1, line: 2 }]);
  const target = type(graph, "com.acme.Target", [{ name: "run", arity: 0, line: 3 }]);
  const otherTarget = type(graph, "com.acme.OtherTarget", [{ name: "run", arity: 0, line: 4 }]);
  const statementNode = graph.addNode({ type: "statement", key: "one.select", name: "one.select" });
  const firstFile = javaFile([firstCaller], {
    fields: [{ ownerType: firstCaller.fullName, name: "service", type: target.fullName }],
    statementUses: [{ ownerType: firstCaller.fullName, enclosingMethod: "call", statementId: "one.select", operation: "query", evidence: { file: "First.java", line: 5, column: 1, snippet: "one.select" } }],
  });
  const secondFile = javaFile([secondCaller], {
    calls: [{ ownerType: secondCaller.fullName, receiver: "service", method: "run", enclosingMethod: "call", evidence: { file: "Second.java", line: 6, column: 1, snippet: "service.run()" } }],
  });

  resolveFacts(graph, {
    javaFiles: [firstFile, secondFile, javaFile([target]), javaFile([otherTarget])],
    statements: [{ id: "select", fullId: "one.select", node: statementNode }],
    routeTargets: [],
  });

  assert.deepEqual([...graph.edges.values()].filter((edge) => edge.type === "calls"), []);
  const uses = [...graph.edges.values()].filter((edge) => edge.type === "uses_statement");
  assert.equal(uses.length, 1);
  assert.equal(uses[0].source, firstCaller.methods[0].node.id);
});

test("resolver uses method-scoped local variable types for ambiguous calls", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const caller = type(graph, "com.acme.Caller", [{ name: "execute", arity: 0, line: 1 }]);
  const service = type(graph, "com.acme.OrderService", [{ name: "audit", arity: 0, line: 10 }]);
  const unrelated = type(graph, "com.acme.OtherService", [{ name: "audit", arity: 0, line: 20 }]);
  const callerFile = javaFile([caller], {
    localVariables: [{
      ownerType: caller.fullName,
      enclosingMethod: "execute",
      name: "service",
      type: "OrderService",
      evidence: { file: "Caller.java", line: 2, column: 1, snippet: "OrderService service" },
    }],
    calls: [{
      ownerType: caller.fullName,
      receiver: "service",
      method: "audit",
      enclosingMethod: "execute",
      evidence: { file: "Caller.java", line: 3, column: 1, snippet: "service.audit()" },
    }],
  });

  resolveFacts(graph, {
    javaFiles: [callerFile, javaFile([service]), javaFile([unrelated])],
    statements: [],
    procedures: [],
    routeTargets: [],
  });

  const calls = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, caller.methods[0].node.id);
  assert.equal(calls[0].target, service.methods[0].node.id);
  assert.equal(calls[0].confidence, 0.9);
  assert.equal(calls[0].reason, "local variable type OrderService");
});

test("resolver uses the nearest preceding declaration when a local name is reused", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const caller = type(graph, "com.acme.Caller", [{ name: "execute", arity: 0, line: 1 }]);
  const firstService = type(graph, "com.acme.FirstService", [{ name: "audit", arity: 0, line: 10 }]);
  const secondService = type(graph, "com.acme.SecondService", [{ name: "audit", arity: 0, line: 20 }]);
  const callerFile = javaFile([caller], {
    localVariables: [
      { ownerType: caller.fullName, enclosingMethod: "execute", name: "service", type: "FirstService", evidence: { file: "Caller.java", line: 2, column: 3, snippet: "FirstService service" } },
      { ownerType: caller.fullName, enclosingMethod: "execute", name: "service", type: "SecondService", evidence: { file: "Caller.java", line: 5, column: 3, snippet: "SecondService service" } },
    ],
    calls: [
      { ownerType: caller.fullName, receiver: "service", method: "audit", enclosingMethod: "execute", evidence: { file: "Caller.java", line: 3, column: 3, snippet: "service.audit()" } },
      { ownerType: caller.fullName, receiver: "service", method: "audit", enclosingMethod: "execute", evidence: { file: "Caller.java", line: 6, column: 3, snippet: "service.audit()" } },
    ],
  });

  resolveFacts(graph, {
    javaFiles: [callerFile, javaFile([firstService]), javaFile([secondService])],
    statements: [],
    procedures: [],
    routeTargets: [],
  });

  const calls = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.deepEqual(calls.map((edge) => edge.target), [firstService.methods[0].node.id, secondService.methods[0].node.id]);
});

test("resolver keeps local variables and calls inside the matching overload", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const caller = type(graph, "com.acme.Caller", [
    { name: "execute", arity: 0, line: 1 },
    { name: "execute", arity: 1, line: 10 },
  ]);
  const firstService = type(graph, "com.acme.FirstService", [{ name: "audit", arity: 0, line: 20 }]);
  const secondService = type(graph, "com.acme.SecondService", [{ name: "audit", arity: 0, line: 30 }]);
  const callerFile = javaFile([caller], {
    localVariables: [
      { ownerType: caller.fullName, enclosingMethod: "execute", enclosingMethodArity: 0, name: "service", type: "FirstService", evidence: { file: "Caller.java", line: 2, column: 3, snippet: "FirstService service" } },
      { ownerType: caller.fullName, enclosingMethod: "execute", enclosingMethodArity: 1, name: "service", type: "SecondService", evidence: { file: "Caller.java", line: 11, column: 3, snippet: "SecondService service" } },
    ],
    calls: [
      { ownerType: caller.fullName, receiver: "service", method: "audit", enclosingMethod: "execute", enclosingMethodArity: 0, evidence: { file: "Caller.java", line: 3, column: 3, snippet: "service.audit()" } },
      { ownerType: caller.fullName, receiver: "service", method: "audit", enclosingMethod: "execute", enclosingMethodArity: 1, evidence: { file: "Caller.java", line: 12, column: 3, snippet: "service.audit()" } },
    ],
  });

  resolveFacts(graph, {
    javaFiles: [callerFile, javaFile([firstService]), javaFile([secondService])],
    statements: [],
    procedures: [],
    routeTargets: [],
  });

  const calls = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.deepEqual(calls.map((edge) => [edge.source, edge.target]), [
    [caller.methods[0].node.id, firstService.methods[0].node.id],
    [caller.methods[1].node.id, secondService.methods[0].node.id],
  ]);
});

test("resolver keeps same-arity overloads inside the matching parameter signature", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const caller = type(graph, "com.acme.Caller", [
    { name: "execute", arity: 1, signature: "String", line: 1 },
    { name: "execute", arity: 1, signature: "Integer", line: 10 },
  ]);
  const firstService = type(graph, "com.acme.FirstService", [{ name: "audit", arity: 0, line: 20 }]);
  const secondService = type(graph, "com.acme.SecondService", [{ name: "audit", arity: 0, line: 30 }]);
  const callerFile = javaFile([caller], {
    localVariables: [
      { ownerType: caller.fullName, enclosingMethod: "execute", enclosingMethodArity: 1, enclosingMethodSignature: "String", name: "service", type: "FirstService", evidence: { file: "Caller.java", line: 2, column: 3, snippet: "FirstService service" } },
      { ownerType: caller.fullName, enclosingMethod: "execute", enclosingMethodArity: 1, enclosingMethodSignature: "Integer", name: "service", type: "SecondService", evidence: { file: "Caller.java", line: 11, column: 3, snippet: "SecondService service" } },
    ],
    calls: [
      { ownerType: caller.fullName, receiver: "service", method: "audit", enclosingMethod: "execute", enclosingMethodArity: 1, enclosingMethodSignature: "String", evidence: { file: "Caller.java", line: 3, column: 3, snippet: "service.audit()" } },
      { ownerType: caller.fullName, receiver: "service", method: "audit", enclosingMethod: "execute", enclosingMethodArity: 1, enclosingMethodSignature: "Integer", evidence: { file: "Caller.java", line: 12, column: 3, snippet: "service.audit()" } },
    ],
  });

  resolveFacts(graph, {
    javaFiles: [callerFile, javaFile([firstService]), javaFile([secondService])],
    statements: [],
    procedures: [],
    routeTargets: [],
  });

  const calls = [...graph.edges.values()].filter((edge) => edge.type === "calls");
  assert.deepEqual(calls.map((edge) => [edge.source, edge.target]), [
    [caller.methods[0].node.id, firstService.methods[0].node.id],
    [caller.methods[1].node.id, secondService.methods[0].node.id],
  ]);
});

test("resolver scopes statement uses by the matching parameter signature", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const owner = type(graph, "com.acme.Dao", [
    { name: "load", arity: 1, signature: "String", line: 1 },
    { name: "load", arity: 1, signature: "Integer", line: 10 },
  ]);
  const firstNode = graph.addNode({ type: "statement", key: "one.select", name: "one.select" });
  const secondNode = graph.addNode({ type: "statement", key: "two.select", name: "two.select" });
  const ownerFile = javaFile([owner], {
    statementUses: [
      { ownerType: owner.fullName, enclosingMethod: "load", enclosingMethodArity: 1, enclosingMethodSignature: "String", statementId: "one.select", operation: "query", evidence: { file: "Dao.java", line: 2, column: 1, snippet: "one.select" } },
      { ownerType: owner.fullName, enclosingMethod: "load", enclosingMethodArity: 1, enclosingMethodSignature: "Integer", statementId: "two.select", operation: "query", evidence: { file: "Dao.java", line: 11, column: 1, snippet: "two.select" } },
    ],
  });

  resolveFacts(graph, {
    javaFiles: [ownerFile],
    statements: [
      { id: "select", fullId: "one.select", node: firstNode },
      { id: "select", fullId: "two.select", node: secondNode },
    ],
    routeTargets: [],
  });

  const uses = [...graph.edges.values()].filter((edge) => edge.type === "uses_statement");
  assert.deepEqual(uses.map((edge) => [edge.source, edge.target]), [
    [owner.methods[0].node.id, firstNode.id],
    [owner.methods[1].node.id, secondNode.id],
  ]);
});

test("resolver preserves full and short statement resolution and evidence order", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const owner = type(graph, "com.acme.Dao", [{ name: "load", arity: 0, line: 1 }]);
  const firstNode = graph.addNode({
    type: "statement",
    key: "one.select",
    name: "one.select",
    evidence: [{ file: "one.xml", line: 10, column: 1, snippet: "one" }],
  });
  const secondNode = graph.addNode({
    type: "statement",
    key: "two.select",
    name: "two.select",
    evidence: [{ file: "two.xml", line: 20, column: 1, snippet: "two" }],
  });
  const exactEvidence = { file: "Dao.java", line: 5, column: 1, snippet: "one.select" };
  const shortEvidence = { file: "Dao.java", line: 6, column: 1, snippet: "select" };
  const ownerFile = javaFile([owner], {
    statementUses: [
      { ownerType: owner.fullName, enclosingMethod: "load", statementId: "one.select", operation: "query", evidence: exactEvidence },
      { ownerType: owner.fullName, enclosingMethod: "load", statementId: "select", operation: "query", evidence: shortEvidence },
    ],
  });

  resolveFacts(graph, {
    javaFiles: [ownerFile],
    statements: [
      { id: "select", fullId: "one.select", node: firstNode },
      { id: "select", fullId: "two.select", node: secondNode },
    ],
    routeTargets: [],
  });

  const uses = [...graph.edges.values()].filter((edge) => edge.type === "uses_statement");
  assert.deepEqual(uses.map((edge) => edge.target), [firstNode.id, secondNode.id]);
  assert.deepEqual(uses.map((edge) => edge.confidence), [1, 0.5]);
  assert.deepEqual(uses.map((edge) => edge.evidence[0].line), [5, 6]);
  assert.deepEqual(owner.methods[0].node.searchText, ["one.select", "query", "select"]);
});

test("resolver preserves exact and wildcard route matching order", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const exact = graph.addNode({ type: "route", key: "/orders/list", name: "/orders/list" });
  const wildcard = graph.addNode({ type: "route", key: "/orders/*", name: "/orders/*" });
  const concrete = graph.addNode({ type: "route", key: "/orders/detail", name: "/orders/detail" });
  const target = type(graph, "com.acme.OrderAction", [{ name: "execute", arity: 0, line: 4 }]);
  const facts = {
    javaFiles: [javaFile([target])],
    statements: [],
    routeTargets: [
      { routeNode: exact, targetClass: target.fullName, source: "Struts action mapping", evidence: { file: "struts.xml", line: 1, column: 1, snippet: "exact" } },
      { routeNode: wildcard, targetClass: target.fullName, source: "Struts action mapping", evidence: { file: "struts.xml", line: 2, column: 1, snippet: "wildcard" } },
    ],
  };

  resolveFacts(graph, facts);
  const mappings = [...graph.edges.values()].filter((edge) => edge.type === "maps_to");
  assert.deepEqual(mappings.map((edge) => edge.source), [exact.id, wildcard.id, concrete.id]);
  assert.deepEqual(mappings.map((edge) => edge.evidence[0].line), [1, 2, 2]);
});

test("resolver maps only class route targets and requires an exact static member name", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const exactRoute = graph.addNode({ type: "route", key: "/exact", name: "/exact" });
  const simpleRoute = graph.addNode({ type: "route", key: "/simple", name: "/simple" });
  const interfaceRoute = graph.addNode({ type: "route", key: "/contract", name: "/contract" });
  const member = type(graph, "com.acme.Container$OrderAction", [], {
    kind: "class",
    name: "OrderAction",
    topLevel: false,
    staticMember: true,
  });
  const contract = type(graph, "com.acme.ActionContract", [], { kind: "interface" });

  resolveFacts(graph, {
    javaFiles: [javaFile([member, contract])],
    statements: [],
    routeTargets: [
      {
        routeNode: exactRoute,
        targetClass: member.fullName,
        source: "Struts action mapping",
        evidence: { file: "struts.xml", line: 1, column: 1, snippet: "exact" },
      },
      {
        routeNode: simpleRoute,
        targetClass: "OrderAction",
        source: "Struts action mapping",
        evidence: { file: "struts.xml", line: 2, column: 1, snippet: "simple" },
      },
      {
        routeNode: interfaceRoute,
        targetClass: contract.fullName,
        source: "Struts action mapping",
        evidence: { file: "struts.xml", line: 3, column: 1, snippet: "interface" },
      },
    ],
  });

  const mappings = [...graph.edges.values()].filter((edge) => edge.type === "maps_to");
  assert.deepEqual(mappings.map((edge) => [edge.source, edge.target]), [
    [exactRoute.id, member.node.id],
  ]);
});

test("resolver preserves request hint dispatch order", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders", name: "/orders" });
  graph.addNodeDataItem(route, "requestHints", { method: "POST", parameters: { action: "save" } });
  graph.addNodeDataItem(route, "requestHints", { method: "GET", parameters: { action: "list" } });
  const target = type(graph, "com.acme.OrderAction", [
    { name: "save", arity: 0, line: 1 },
    { name: "list", arity: 0, line: 2 },
  ], { extendsType: "DispatchAction" });

  resolveFacts(graph, {
    javaFiles: [javaFile([target])],
    statements: [],
    routeTargets: [{
      routeNode: route,
      targetClass: target.fullName,
      source: "Struts action mapping",
      dispatchParameter: "action",
      evidence: { file: "struts.xml", line: 3, column: 1, snippet: "action" },
    }],
  });

  const dispatches = [...graph.edges.values()].filter((edge) => edge.type === "dispatches_to");
  assert.deepEqual(dispatches.map((edge) => edge.target), [target.methods[0].node.id, target.methods[1].node.id]);
  assert.deepEqual(dispatches.map((edge) => edge.confidence), [1, 1]);
});

test("resolver follows inherited Struts entry methods to template handlers", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/account/edit.do", name: "/account/edit.do" });
  const listRoute = graph.addNode({ type: "route", key: "/account/list.do", name: "/account/list.do" });
  const secureBase = type(graph, "com.acme.SecureBaseAction", [
    { name: "execute", arity: 4, line: 2 },
    { name: "doExecute", arity: 4, line: 8 },
  ], { extendsType: "Action" });
  const editAccount = type(graph, "com.acme.EditAccountAction", [
    { name: "doExecute", arity: 4, line: 20 },
  ], { extendsType: "SecureBaseAction" });
  const listAccounts = type(graph, "com.acme.ListAccountsAction", [
    { name: "doExecute", arity: 4, line: 30 },
  ], { extendsType: "SecureBaseAction" });

  resolveFacts(graph, {
    javaFiles: [javaFile([secureBase]), javaFile([editAccount]), javaFile([listAccounts])],
    statements: [],
    routeTargets: [
      {
        routeNode: route,
        targetClass: editAccount.fullName,
        source: "Struts action mapping",
        evidence: { file: "struts-config.xml", line: 1, column: 1, snippet: "editAccount" },
      },
      {
        routeNode: listRoute,
        targetClass: listAccounts.fullName,
        source: "Struts action mapping",
        evidence: { file: "struts-config.xml", line: 2, column: 1, snippet: "listAccounts" },
      },
    ],
  });

  const dispatches = [...graph.edges.values()].filter((edge) => edge.type === "dispatches_to"
    && edge.source === route.id);
  assert.deepEqual(dispatches.map((edge) => [edge.target, edge.reason, edge.confidence]), [
    [secureBase.methods[0].node.id, "Inherited Action entry convention", 0.9],
    [editAccount.methods[0].node.id, "Action template handler via inherited execute", 0.9],
  ]);
  assert.equal(dispatches.some((edge) => edge.target === listAccounts.methods[0].node.id), false);
  assert.equal([...graph.edges.values()].some((edge) => edge.reason === "inherited Action template method override"), false);
  assert.equal([...graph.warnings].some((warning) => warning.includes("unresolved route entry")), false);
});

test("resolver chooses the nearest inherited Struts template handler", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/account/edit.do", name: "/account/edit.do" });
  const grand = type(graph, "com.acme.GrandAction", [
    { name: "execute", arity: 4, line: 2 },
    { name: "doExecute", arity: 4, line: 8 },
  ], { extendsType: "Action" });
  const middle = type(graph, "com.acme.MiddleAction", [
    { name: "doExecute", arity: 4, line: 20 },
  ], { extendsType: "GrandAction" });
  const leaf = type(graph, "com.acme.LeafAction", [], { extendsType: "MiddleAction" });

  resolveFacts(graph, {
    javaFiles: [javaFile([grand]), javaFile([middle]), javaFile([leaf])],
    statements: [],
    routeTargets: [{
      routeNode: route,
      targetClass: leaf.fullName,
      source: "Struts action mapping",
      evidence: { file: "struts-config.xml", line: 1, column: 1, snippet: "leaf" },
    }],
  });

  const handlers = [...graph.edges.values()]
    .filter((edge) => edge.source === route.id && edge.type === "dispatches_to")
    .map((edge) => edge.target);
  assert.deepEqual(handlers, [grand.methods[0].node.id, middle.methods[0].node.id]);
});

test("resolver matches inherited Struts template overloads by signature", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/account/edit.do", name: "/account/edit.do" });
  const actionSignature = "ActionMapping,ActionForm,HttpServletRequest,HttpServletResponse";
  const grand = type(graph, "com.acme.GrandAction", [
    { name: "execute", arity: 4, signature: actionSignature, line: 2 },
    { name: "doExecute", arity: 4, signature: "String,String,String,String", line: 8 },
    { name: "doExecute", arity: 4, signature: actionSignature, line: 12 },
  ], { extendsType: "Action" });
  const leaf = type(graph, "com.acme.LeafAction", [
    { name: "doExecute", arity: 4, signature: actionSignature, line: 20 },
  ], { extendsType: "GrandAction" });

  resolveFacts(graph, {
    javaFiles: [javaFile([grand]), javaFile([leaf])],
    statements: [],
    routeTargets: [{
      routeNode: route,
      targetClass: leaf.fullName,
      source: "Struts action mapping",
      evidence: { file: "struts-config.xml", line: 1, column: 1, snippet: "leaf" },
    }],
  });

  const handlers = [...graph.edges.values()]
    .filter((edge) => edge.source === route.id && edge.type === "dispatches_to")
    .map((edge) => edge.target);
  assert.deepEqual(handlers, [grand.methods[0].node.id, leaf.methods[0].node.id]);
});

test("resolver uses the servlet service convention without request hints", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/legacy", name: "/legacy" });
  const servlet = type(graph, "com.acme.LegacyServlet", [
    { name: "service", arity: 2, line: 2 },
  ], { extendsType: "HttpServlet" });

  resolveFacts(graph, {
    javaFiles: [javaFile([servlet])],
    statements: [],
    routeTargets: [{
      routeNode: route,
      targetClass: servlet.fullName,
      source: "servlet",
      evidence: { file: "web.xml", line: 1, column: 1, snippet: "LegacyServlet" },
    }],
  });

  const dispatches = [...graph.edges.values()].filter((edge) => edge.type === "dispatches_to");
  assert.deepEqual(dispatches.map((edge) => [edge.target, edge.reason]), [[servlet.methods[0].node.id, "Servlet service convention"]]);
});
