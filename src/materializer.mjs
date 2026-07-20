import path from "node:path";

import { GraphBuilder } from "./graph.mjs";
import { normalizeRequestUrl, webPathForFile } from "./parsers/jsp.mjs";
import { resolveFacts } from "./resolver.mjs";

function fileNode(graph, file) {
  return graph.addNode({
    type: "file",
    key: file.path,
    name: path.posix.basename(file.path),
    filePath: file.path,
    data: { language: file.language, category: file.category },
    searchText: [file.path, file.language],
  });
}

function addParserWarnings(graph, warnings = []) {
  for (const warning of warnings) graph.addWarning(warning);
}

function addRoute(graph, ownerNode, request, edgeType) {
  const route = graph.addNode({
    type: "route",
    key: request.url,
    name: request.url,
    evidence: [request.evidence],
    searchText: [request.url, request.kind ?? request.source ?? ""],
  });
  if (request.method || request.parameters) {
    const hint = {
      method: request.method ?? "",
      parameters: request.parameters ?? {},
      evidence: request.evidence,
    };
    graph.addNodeDataItem(route, "requestHints", hint);
  }
  graph.addEdge({
    source: ownerNode.id,
    target: route.id,
    type: edgeType,
    confidence: 1,
    reason: request.kind ? `${request.kind} request` : request.source,
    evidence: [request.evidence],
  });
  return route;
}

function methodRecord(graph, type, method, disambiguateSignature = false) {
  const arity = method.parameters.length;
  const signature = method.methodSignature
    || `@${method.evidence?.line ?? 0}:${method.evidence?.column ?? 0}`;
  const node = graph.addNode({
    type: "java_method",
    key: `${type.fullName}#${method.name}/${arity}${disambiguateSignature ? `(${signature})` : ""}`,
    name: `${type.name}.${method.name}`,
    filePath: type.node.filePath,
    evidence: [method.evidence],
    data: { owner: type.fullName, method: method.name, arity, parameters: method.parameters, returnType: method.returnType },
    searchText: [type.fullName, type.name, method.name, ...method.parameters],
  });
  graph.addEdge({
    source: type.node.id,
    target: node.id,
    type: "declares",
    confidence: 1,
    reason: "Java method declaration",
    evidence: [method.evidence],
  });
  return { ...method, arity, node };
}

function canonicalStruts2Request(request, struts2RoutesByName) {
  if (!request.url?.toLowerCase().endsWith(".action")) return request;
  const actionName = path.posix.basename(request.url).replace(/\.action$/i, "");
  const candidates = struts2RoutesByName.get(actionName) ?? [];
  const urls = [...new Set(candidates.map((candidate) => candidate.url))];
  return urls.length === 1 ? { ...request, url: urls[0] } : request;
}

function materializeJsp(graph, record, file, sourceFile, pageFileByWebPath, sourceFileByWebPath, struts2RoutesByName) {
  const parsed = record.facts;
  const page = graph.addNode({
    type: "page",
    key: file.path,
    name: path.posix.basename(file.path),
    filePath: file.path,
    evidence: parsed.textEntries.map((entry) => entry.evidence),
    searchText: [file.path, parsed.visibleText, ...parsed.textEntries.map((entry) => entry.text), ...parsed.fields.map((field) => field.name)],
    data: { visibleText: parsed.visibleText, fields: parsed.fields.map((field) => field.name) },
  });
  graph.addEdge({ source: sourceFile.id, target: page.id, type: "contains", confidence: 1, reason: "JSP page" });
  for (const request of parsed.requests) {
    const edgeType = request.kind === "form" ? "submits_to" : request.kind === "link" ? "links_to" : "requests";
    addRoute(graph, page, canonicalStruts2Request(request, struts2RoutesByName), edgeType);
  }
  for (const include of parsed.includes) {
    const includeWebPath = normalizeRequestUrl(include.path, webPathForFile(file.path));
    const realPagePath = pageFileByWebPath.get(includeWebPath) ?? "";
    const includedPage = graph.addNode({
      type: "page",
      key: realPagePath || includeWebPath.replace(/^\//, ""),
      name: realPagePath ? path.posix.basename(realPagePath) : include.path,
      ...(realPagePath ? { filePath: realPagePath } : {}),
      evidence: [include.evidence],
      searchText: [include.path, realPagePath],
    });
    graph.addEdge({
      source: page.id,
      target: includedPage.id,
      type: "includes",
      confidence: 1,
      reason: "JSP include",
      evidence: [include.evidence],
    });
  }
  for (const script of parsed.scripts) {
    const targetFile = sourceFileByWebPath.get(script.path);
    if (!targetFile) {
      graph.addWarning(`unresolved JSP script: ${script.path} at ${script.evidence.file}:${script.evidence.line}`);
      continue;
    }
    const scriptFile = fileNode(graph, targetFile);
    graph.addEdge({
      source: page.id,
      target: scriptFile.id,
      type: "loads_script",
      confidence: 1,
      reason: "JSP script src",
      evidence: [script.evidence],
    });
  }
}

function materializeJava(graph, record, file, sourceFile, resolverFacts) {
  const parsed = record.facts;
  const typeRecords = parsed.types.map((type) => {
    const node = graph.addNode({
      type: "java_type",
      key: type.fullName,
      name: type.name,
      filePath: file.path,
      evidence: [type.evidence],
      data: { kind: type.kind, packageName: parsed.packageName, extendsType: type.extendsType, implementsTypes: type.implementsTypes },
      searchText: [file.path, type.name, type.fullName, type.extendsType, ...type.implementsTypes],
    });
    graph.addEdge({ source: sourceFile.id, target: node.id, type: "contains", confidence: 1, reason: "Java type" });
    const typeRecord = { ...type, node, methods: [] };
    const typeMethods = parsed.methods.filter((method) => method.ownerType === type.fullName);
    const overloadCounts = new Map();
    for (const method of typeMethods) {
      const overloadKey = `${method.name}/${method.parameters.length}`;
      overloadCounts.set(overloadKey, (overloadCounts.get(overloadKey) ?? 0) + 1);
    }
    typeRecord.methods = typeMethods.map((method) => methodRecord(
      graph,
      typeRecord,
      method,
      overloadCounts.get(`${method.name}/${method.parameters.length}`) > 1,
    ));
    return typeRecord;
  });
  resolverFacts.javaFiles.push({ ...parsed, file, sourceFile, types: typeRecords });
}

function pageNodeForPath(graph, rawPath, evidence, pageFileByWebPath, searchText = []) {
  const webPath = normalizeRequestUrl(rawPath);
  const realPagePath = pageFileByWebPath.get(webPath) ?? "";
  return graph.addNode({
    type: "page",
    key: realPagePath || webPath.replace(/^\//, ""),
    name: realPagePath ? path.posix.basename(realPagePath) : rawPath,
    ...(realPagePath ? { filePath: realPagePath } : {}),
    evidence: [evidence],
    searchText: [rawPath, realPagePath, ...searchText],
  });
}

function tileNameForPath(rawPath) {
  const value = String(rawPath ?? "").trim().replace(/^\/+/, "");
  return value && !value.includes("/") ? value : "";
}

function tileNode(graph, name, evidence, filePath = "") {
  return graph.addNode({
    type: "tiles_definition",
    key: name,
    name,
    ...(filePath ? { filePath } : {}),
    evidence: evidence ? [evidence] : [],
    searchText: [name],
  });
}

function materializeSql(graph, record, file, sourceFile, resolverFacts) {
  for (const procedure of record.facts.procedures) {
    const node = graph.addNode({
      type: "procedure",
      key: procedure.fullName,
      name: procedure.fullName,
      filePath: file.path,
      evidence: [procedure.evidence],
      data: {
        parameters: procedure.parameters,
        body: procedure.body,
        reads: procedure.reads,
        writes: procedure.writes,
        calls: procedure.calls,
      },
      searchText: [file.path, procedure.name, procedure.fullName, ...procedure.parameters, ...procedure.reads, ...procedure.writes, ...procedure.calls],
    });
    graph.addEdge({ source: sourceFile.id, target: node.id, type: "contains", confidence: 1, reason: "SQL Server procedure" });
    resolverFacts.procedures.push({ ...procedure, node });
    for (const tableName of procedure.reads) {
      const table = graph.addNode({ type: "table", key: tableName, name: tableName, evidence: [procedure.evidence], searchText: [tableName] });
      graph.addEdge({ source: node.id, target: table.id, type: "reads_from", confidence: 1, reason: "SQL Server procedure SELECT/FROM/JOIN", evidence: [procedure.evidence] });
    }
    for (const tableName of procedure.writes) {
      const table = graph.addNode({ type: "table", key: tableName, name: tableName, evidence: [procedure.evidence], searchText: [tableName] });
      graph.addEdge({ source: node.id, target: table.id, type: "writes_to", confidence: 1, reason: "SQL Server procedure INSERT/UPDATE/DELETE/MERGE", evidence: [procedure.evidence] });
    }
  }
}

function materializeXml(graph, record, file, sourceFile, resolverFacts, pageFileByWebPath, tileDefinitionNames) {
  const { ibatis, web, struts, struts2, tiles, spring } = record.facts;
  if (ibatis) {
    for (const statement of ibatis.statements) {
      const node = graph.addNode({
        type: "statement",
        key: statement.fullId,
        name: statement.fullId,
        filePath: file.path,
        evidence: [statement.evidence],
        data: { ...statement, evidence: undefined },
        searchText: [file.path, statement.id, statement.fullId, statement.type, statement.sql, ...statement.reads, ...statement.writes],
      });
      graph.addEdge({ source: sourceFile.id, target: node.id, type: "contains", confidence: 1, reason: "iBATIS statement" });
      resolverFacts.statements.push({ ...statement, node });
      for (const tableName of statement.reads) {
        const table = graph.addNode({ type: "table", key: tableName, name: tableName, evidence: [statement.evidence], searchText: [tableName] });
        graph.addEdge({ source: node.id, target: table.id, type: "reads_from", confidence: 1, reason: "SQL FROM/JOIN", evidence: [statement.evidence] });
      }
      for (const tableName of statement.writes) {
        const table = graph.addNode({ type: "table", key: tableName, name: tableName, evidence: [statement.evidence], searchText: [tableName] });
        graph.addEdge({ source: node.id, target: table.id, type: "writes_to", confidence: 1, reason: `SQL ${statement.type}`, evidence: [statement.evidence] });
      }
    }
  }

  if (web) {
    for (const routeFact of web.routes) {
      const routeNode = addRoute(graph, sourceFile, { ...routeFact, kind: routeFact.source }, "contains");
      resolverFacts.routeTargets.push({ ...routeFact, routeNode });
    }
  }
  if (struts) {
    for (const action of struts.actions) {
      const routeNode = addRoute(graph, sourceFile, { url: action.url, evidence: action.evidence, source: "Struts action", kind: "struts" }, "contains");
      resolverFacts.routeTargets.push({
        routeNode,
        targetClass: action.type,
        source: "Struts action mapping",
        evidence: action.evidence,
        dispatchParameter: action.parameter,
      });
      for (const forward of action.forwards) {
        const tileName = tileNameForPath(forward.path);
        if (tileName && tileDefinitionNames.has(tileName)) {
          const tile = tileNode(graph, tileName, forward.evidence);
          graph.addEdge({ source: routeNode.id, target: tile.id, type: "uses_tile", confidence: 1, reason: `Struts forward ${forward.name} resolves to Tiles definition`, evidence: [forward.evidence] });
          continue;
        }
        const forwardWebPath = normalizeRequestUrl(forward.path);
        const realPagePath = pageFileByWebPath.get(forwardWebPath) ?? "";
        const page = graph.addNode({
          type: "page",
          key: realPagePath || forwardWebPath.replace(/^\//, ""),
          name: realPagePath ? path.posix.basename(realPagePath) : forward.path,
          ...(realPagePath ? { filePath: realPagePath } : {}),
          evidence: [forward.evidence],
          searchText: [forward.name, forward.path, realPagePath],
        });
        graph.addEdge({ source: routeNode.id, target: page.id, type: "forwards_to", confidence: 1, reason: `Struts forward ${forward.name}`, evidence: [forward.evidence] });
      }
    }
  }
  if (struts2) {
    for (const action of struts2.actions) {
      const routeNode = addRoute(graph, sourceFile, { url: action.url, evidence: action.evidence, source: "Struts 2 action", kind: "struts2" }, "contains");
      resolverFacts.routeTargets.push({
        routeNode,
        targetClass: action.className,
        source: "Struts 2 action mapping",
        evidence: action.evidence,
        dispatchMethod: action.method,
        dispatchMethodExplicit: action.methodExplicit,
      });
      for (const result of action.results) {
        if (!result.path) continue;
        if (result.type.toLowerCase() === "redirectaction") {
          const actionName = (result.actionName || result.path).replace(/^\/+/, "");
          const targetNamespace = result.namespace || action.namespace;
          const prefix = targetNamespace && targetNamespace !== "/" ? `/${targetNamespace.replace(/^\/+|\/+$/g, "")}` : "";
          const extension = action.extension ?? ".action";
          const targetUrl = `${prefix}/${actionName}${actionName.toLowerCase().endsWith(extension.toLowerCase()) ? "" : extension}`.replace(/\/{2,}/g, "/");
          const targetRoute = graph.addNode({ type: "route", key: targetUrl, name: targetUrl, evidence: [result.evidence], searchText: [targetUrl, "Struts 2 redirectAction"] });
          graph.addEdge({ source: routeNode.id, target: targetRoute.id, type: "redirects_to", confidence: 1, reason: `Struts 2 redirectAction result ${result.name}`, evidence: [result.evidence] });
          continue;
        }
        const page = pageNodeForPath(graph, result.path, result.evidence, pageFileByWebPath, [result.name, result.type]);
        graph.addEdge({ source: routeNode.id, target: page.id, type: "forwards_to", confidence: 1, reason: `Struts 2 result ${result.name}`, evidence: [result.evidence] });
      }
    }
  }
  if (tiles) {
    const nodeByDefinition = new Map();
    for (const definition of tiles.definitions) {
      const node = graph.addNode({
        type: "tiles_definition",
        key: definition.name,
        name: definition.name,
        filePath: file.path,
        evidence: [definition.evidence],
        data: { extendsName: definition.extendsName, template: definition.template, puts: definition.puts.map(({ evidence: _evidence, ...put }) => put) },
        searchText: [file.path, definition.name, definition.extendsName, definition.template, ...definition.puts.flatMap((put) => [put.name, put.value])],
      });
      nodeByDefinition.set(definition.name, node);
      graph.addEdge({ source: sourceFile.id, target: node.id, type: "contains", confidence: 1, reason: "Tiles definition" });
    }
    for (const definition of tiles.definitions) {
      const node = nodeByDefinition.get(definition.name);
      if (definition.extendsName) {
        const parent = nodeByDefinition.get(definition.extendsName) ?? tileNode(graph, definition.extendsName, definition.evidence);
        if (!tileDefinitionNames.has(definition.extendsName)) {
          graph.addWarning(`unresolved Tiles parent: ${definition.name} -> ${definition.extendsName} at ${definition.evidence.file}:${definition.evidence.line}`);
        }
        graph.addEdge({ source: node.id, target: parent.id, type: "extends_tile", confidence: 1, reason: "Tiles definition inheritance", evidence: [definition.evidence] });
      }
      if (definition.template) {
        const template = pageNodeForPath(graph, definition.template, definition.evidence, pageFileByWebPath, [definition.name, "Tiles template"]);
        graph.addEdge({ source: node.id, target: template.id, type: "uses_template", confidence: 1, reason: "Tiles definition template", evidence: [definition.evidence] });
      }
      for (const put of definition.puts) {
        const page = pageNodeForPath(graph, put.value, put.evidence, pageFileByWebPath, [definition.name, put.name]);
        graph.addEdge({ source: node.id, target: page.id, type: "puts", confidence: 1, reason: `Tiles put ${put.name}`, evidence: [put.evidence], data: { name: put.name } });
      }
    }
  }
  if (spring) {
    for (const bean of spring.beans) {
      const beanNode = graph.addNode({ type: "spring_bean", key: bean.id, name: bean.id, filePath: file.path, evidence: [bean.evidence], data: { className: bean.className }, searchText: [bean.id, bean.className] });
      graph.addEdge({ source: sourceFile.id, target: beanNode.id, type: "contains", confidence: 1, reason: "Spring bean" });
      resolverFacts.springBeans.push({ ...bean, node: beanNode });
    }
    for (const routeFact of spring.routes) {
      const routeNode = addRoute(graph, sourceFile, { ...routeFact, kind: routeFact.source }, "contains");
      resolverFacts.routeTargets.push({ ...routeFact, routeNode, source: "Spring SimpleUrlHandlerMapping" });
    }
  }
}

function fileFromRecord(record) {
  return {
    path: record.relativePath,
    language: record.language,
    category: record.category,
    size: record.size,
  };
}

export function materializeRecords({ projectRoot, records, skipped = [] }) {
  const ordered = [...records].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const graph = new GraphBuilder({ projectRoot });
  for (const entry of skipped) {
    if (["file-too-large", "binary-file", "symbolic-link"].includes(entry.reason)) {
      graph.addWarning(`skipped ${entry.reason}: ${entry.path}`);
    }
  }

  const resolverFacts = { javaFiles: [], routeTargets: [], statements: [], procedures: [], springBeans: [] };
  const materializable = ordered.filter((record) => record.status !== "binary");
  const files = materializable.map(fileFromRecord);
  const pageFileByWebPath = new Map(
    files.filter((file) => file.language === "jsp").map((file) => [webPathForFile(file.path), file.path]),
  );
  const tileDefinitionNames = new Set(
    ordered
      .filter((record) => record.status === "parsed" && record.parserKind === "xml")
      .flatMap((record) => record.facts.tiles?.definitions?.map((definition) => definition.name) ?? []),
  );
  const sourceFileByWebPath = new Map(
    files.filter((file) => ["jsp", "javascript"].includes(file.language)).map((file) => [webPathForFile(file.path), file]),
  );
  const struts2RoutesByName = new Map();
  for (const action of ordered
    .filter((record) => record.status === "parsed" && record.parserKind === "xml")
    .flatMap((record) => record.facts.struts2?.actions ?? [])) {
    if (!action.name || /[*{}]/.test(action.name)) continue;
    const actionPathName = path.posix.basename(action.name);
    const extension = String(action.extension ?? ".action").toLowerCase();
    const actionName = extension && actionPathName.toLowerCase().endsWith(extension)
      ? actionPathName.slice(0, -extension.length)
      : actionPathName;
    const candidates = struts2RoutesByName.get(actionName) ?? [];
    candidates.push(action);
    struts2RoutesByName.set(actionName, candidates);
  }

  for (const record of ordered) {
    if (record.status === "binary") {
      graph.addWarning(`skipped binary-file: ${record.relativePath}`);
      continue;
    }
    const file = fileFromRecord(record);
    const sourceFile = fileNode(graph, file);
    addParserWarnings(graph, record.warnings);
    if (record.status === "error") graph.addWarning(`skipped parser-error: ${record.relativePath}`);
    if (record.status !== "parsed") continue;

    if (record.parserKind === "jsp") {
      materializeJsp(graph, record, file, sourceFile, pageFileByWebPath, sourceFileByWebPath, struts2RoutesByName);
    } else if (record.parserKind === "javascript") {
      for (const request of record.facts.requests) addRoute(graph, sourceFile, request, "requests");
    } else if (record.parserKind === "java") {
      materializeJava(graph, record, file, sourceFile, resolverFacts);
    } else if (record.parserKind === "xml") {
      materializeXml(graph, record, file, sourceFile, resolverFacts, pageFileByWebPath, tileDefinitionNames);
    } else if (record.parserKind === "sql") {
      materializeSql(graph, record, file, sourceFile, resolverFacts);
    }
  }

  resolveFacts(graph, resolverFacts);
  return graph.toJSON();
}
