import path from "node:path";

import { GraphBuilder } from "./graph.mjs";
import { isValidOutcomeName } from "./outcome-metadata.mjs";
import { normalizeRequestUrl, webPathForFile } from "./parsers/jsp.mjs";
import { resolveFacts } from "./resolver.mjs";
import { effectiveTilePages } from "./tile-composition.mjs";

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
  if (Object.hasOwn(request, "method")
    || Object.hasOwn(request, "parameters")
    || Object.hasOwn(request, "dispatchMethod")) {
    const hint = {
      method: request.method ?? "",
      parameters: request.parameters ?? {},
      evidence: request.evidence,
      ...(typeof request.dispatchMethod === "string"
        ? { dispatchMethod: request.dispatchMethod }
        : {}),
      ...(typeof request.parametersComplete === "boolean"
        ? { parametersComplete: request.parametersComplete }
        : {}),
      ...(request.hasDynamicParameterNames === true ? { hasDynamicParameterNames: true } : {}),
    };
    graph.addNodeDataItem(route, "requestHints", hint);
  }
  const edge = graph.addEdge({
    source: ownerNode.id,
    target: route.id,
    type: edgeType,
    confidence: 1,
    reason: request.kind ? `${request.kind} request` : request.source,
    evidence: [request.evidence],
    data: request.contextPageId ? { pageIds: [request.contextPageId] } : {},
  });
  if (request.contextPageId) {
    edge.data.pageIds = [...new Set([...(edge.data.pageIds ?? []), request.contextPageId])]
      .sort((left, right) => left.localeCompare(right, "en"));
    const contexts = Array.isArray(edge.data.requestContexts) ? edge.data.requestContexts : [];
    let context = contexts.find((candidate) => candidate.file === request.evidence.file
      && candidate.line === request.evidence.line
      && candidate.column === request.evidence.column);
    if (!context) {
      context = {
        file: request.evidence.file,
        line: request.evidence.line,
        column: request.evidence.column,
        pageIds: [],
      };
      contexts.push(context);
    }
    context.pageIds = [...new Set([...context.pageIds, request.contextPageId])]
      .sort((left, right) => left.localeCompare(right, "en"));
    edge.data.requestContexts = contexts.sort((left, right) => (
      left.file.localeCompare(right.file, "en")
      || left.line - right.line
      || left.column - right.column
    ));
  }
  graph.addEdgeEvidence(edge, [request.evidence]);
  return route;
}

const ARRIVAL_EDGE_TYPES = new Set([
  "forwards_to",
  "redirects_to",
  "uses_tile",
  "includes",
]);

function addPageContext(contextsByPage, pageId, context) {
  const contexts = contextsByPage.get(pageId) ?? new Map();
  const key = `${context.routeUrl}\0${context.topPageId}`;
  if (!contexts.has(key)) contexts.set(key, context);
  contextsByPage.set(pageId, contexts);
}

function propagateArrivalContexts(graph, seeds, contextsByPage, allowedEdgeTypes = ARRIVAL_EDGE_TYPES) {
  const outgoingBySource = new Map();
  for (const edge of [...graph.edges.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    const outgoing = outgoingBySource.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingBySource.set(edge.source, outgoing);
  }
  const queue = [...seeds];
  const visited = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const visitKey = `${current.nodeId}\0${current.routeUrl}\0${current.topPageId}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const node = graph.nodes.get(current.nodeId);
    if (!node) continue;
    const topPageId = node.type === "page" ? current.topPageId || node.id : current.topPageId;
    if (node.type === "page") {
      addPageContext(contextsByPage, node.id, { routeUrl: current.routeUrl, topPageId });
    }
    for (const edge of outgoingBySource.get(node.id) ?? []) {
      if (!allowedEdgeTypes.has(edge.type)) continue;
      const target = graph.nodes.get(edge.target);
      if (!target) continue;
      if (edge.type === "uses_tile" && target.type === "tiles_definition") {
        for (const composition of effectiveTilePages(target.id, graph.nodes, outgoingBySource)) {
          queue.push({
            nodeId: composition.node.id,
            routeUrl: current.routeUrl,
            topPageId,
          });
        }
        continue;
      }
      queue.push({
        nodeId: target.id,
        routeUrl: edge.type === "redirects_to" && target.type === "route"
          ? target.name
          : current.routeUrl,
        topPageId: edge.type === "redirects_to" ? "" : topPageId,
      });
    }
  }
}

function pageArrivalContexts(graph) {
  const contextsByPage = new Map();
  const routeSeeds = [...graph.nodes.values()]
    .filter((node) => node.type === "route")
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map((route) => ({ nodeId: route.id, routeUrl: route.name, topPageId: "" }));
  propagateArrivalContexts(graph, routeSeeds, contextsByPage);

  const pages = [...graph.nodes.values()]
    .filter((node) => node.type === "page")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const includedPageIds = new Set(
    [...graph.edges.values()].filter((edge) => edge.type === "includes").map((edge) => edge.target),
  );
  const fallbackRoots = pages.filter((page) => !contextsByPage.has(page.id) && !includedPageIds.has(page.id));
  propagateArrivalContexts(
    graph,
    fallbackRoots.map((page) => ({
      nodeId: page.id,
      routeUrl: webPathForFile(page.filePath ?? page.name),
      topPageId: page.id,
    })),
    contextsByPage,
    new Set(["includes"]),
  );
  for (const page of pages) {
    if (contextsByPage.has(page.id)) continue;
    propagateArrivalContexts(graph, [{
      nodeId: page.id,
      routeUrl: webPathForFile(page.filePath ?? page.name),
      topPageId: page.id,
    }], contextsByPage, new Set(["includes"]));
  }
  return new Map([...contextsByPage].map(([pageId, contexts]) => [
    pageId,
    [...contexts.values()].sort((left, right) => (
      left.routeUrl.localeCompare(right.routeUrl, "en")
      || left.topPageId.localeCompare(right.topPageId, "en")
    )),
  ]));
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
    searchText: [
      type.fullName,
      ...(type.canonicalName ? [type.canonicalName] : []),
      type.name,
      method.name,
      ...(type.canonicalName && type.canonicalName !== type.fullName
        ? [`${type.canonicalName}.${method.name}`]
        : []),
      ...method.parameters,
    ],
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
  const requestBaseName = path.posix.basename(request.url ?? "");
  const requestExtension = path.posix.extname(requestBaseName).toLowerCase();
  const withoutExtension = requestExtension
    ? requestBaseName.slice(0, -requestExtension.length)
    : requestBaseName;
  const dynamicMethodOffset = withoutExtension.indexOf("!");
  const actionName = dynamicMethodOffset === -1
    ? withoutExtension
    : withoutExtension.slice(0, dynamicMethodOffset);
  if (!actionName) return request;
  const dispatchMethod = dynamicMethodOffset === -1
    ? ""
    : withoutExtension.slice(dynamicMethodOffset + 1);
  if (dynamicMethodOffset !== -1 && !/^[A-Za-z_$][\w$]*$/u.test(dispatchMethod)) return request;
  const hintedRequest = dispatchMethod ? { ...request, dispatchMethod } : request;
  const sourceIsRelative = Object.hasOwn(request, "relativeUrl")
    || request.struts2ActionRelative === true;
  const requestActionPath = path.posix.join(path.posix.dirname(request.url), actionName);
  const candidates = (struts2RoutesByName.get(actionName) ?? []).filter((candidate) => {
    if (sourceIsRelative) return true;
    const configuredUrl = candidate.url;
    const configuredBaseName = path.posix.basename(configuredUrl);
    const configuredExtension = path.posix.extname(configuredBaseName).toLowerCase();
    const configuredActionName = configuredExtension
      ? configuredBaseName.slice(0, -configuredExtension.length)
      : configuredBaseName;
    const configuredActionPath = path.posix.join(path.posix.dirname(configuredUrl), configuredActionName);
    return requestActionPath === configuredActionPath;
  });
  const urls = [...new Set(candidates.map((candidate) => candidate.url))];
  if (urls.length !== 1) return hintedRequest;
  const configuredUrl = urls[0];
  const configuredBaseName = path.posix.basename(configuredUrl);
  const configuredExtension = path.posix.extname(configuredBaseName).toLowerCase();
  const compatibleExtension = requestExtension === ".action"
    || requestExtension === configuredExtension
    || (!requestExtension && request.kind === "form");
  if (!compatibleExtension) return hintedRequest;
  return { ...hintedRequest, url: configuredUrl };
}

function materializeJsp(graph, record, file, sourceFile, pageFileByWebPath, pendingJspPages) {
  const parsed = record.facts;
  const formCount = Number.isInteger(parsed.formCount)
    ? parsed.formCount
    : parsed.requests.filter((request) => request.kind === "form").length;
  const preserveLegacySingleForm = formCount === 1 && !(parsed.unassignedFieldCount > 0);
  const page = graph.addNode({
    type: "page",
    key: file.path,
    name: path.posix.basename(file.path),
    filePath: file.path,
    evidence: parsed.textEntries.map((entry) => entry.evidence),
    searchText: [file.path, parsed.visibleText, ...parsed.textEntries.map((entry) => entry.text), ...parsed.fields.map((field) => field.name)],
    data: {
      visibleText: parsed.visibleText,
      fields: parsed.fields.map((field) => field.name),
      fieldDetails: parsed.fields.map((field) => ({
        name: field.name,
        element: field.element ?? "",
        inputType: field.inputType ?? "",
        staticValue: field.value ?? "",
        runtimeDerived: field.runtimeDerived === true,
        required: field.required === true,
        disabled: field.disabled === true,
        choice: field.choice === true,
        submittable: field.submittable !== false,
        evidence: {
          file: field.evidence.file,
          line: field.evidence.line,
          column: field.evidence.column,
          snippet: `${field.element ?? "field"} field ${field.name}`,
        },
      })),
    },
  });
  graph.addEdge({ source: sourceFile.id, target: page.id, type: "contains", confidence: 1, reason: "JSP page" });
  for (const include of parsed.includes) {
    const includeWebPath = normalizeRequestUrl(include.path, webPathForFile(file.path));
    if (!includeWebPath) continue;
    const realPagePath = pageFileByWebPath.get(includeWebPath) ?? "";
    const includedPageKey = realPagePath || includeWebPath.replace(/^\//, "");
    if (!includedPageKey) continue;
    const includedPage = graph.addNode({
      type: "page",
      key: includedPageKey,
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
  pendingJspPages.push({ page, requests: parsed.requests, scripts: parsed.scripts, preserveLegacySingleForm });
}

function queryParameterNames(request) {
  if (Array.isArray(request.queryParameterNames)) {
    return new Set(request.queryParameterNames.filter((name) => typeof name === "string" && name));
  }
  let target = Object.hasOwn(request, "relativeUrl") ? request.relativeUrl : "";
  if (!target.includes("?") && typeof request.evidence?.snippet === "string") {
    target = request.evidence.snippet;
  }
  const queryOffset = target.indexOf("?");
  if (queryOffset === -1) return new Set();
  const query = target.slice(queryOffset + 1).split(/["'<>\s#]/u, 1)[0].replace(/&amp;/giu, "&");
  return new Set([...new URLSearchParams(query).keys()].filter(Boolean));
}

function materializedJspRequest(request, preserveLegacySingleForm) {
  if (request.kind !== "form") return request;
  const { runtimeValueParameterNames: internalRuntimeValueNames, ...materialized } = request;
  const runtimeValueNames = Array.isArray(internalRuntimeValueNames)
    ? internalRuntimeValueNames.filter((name) => typeof name === "string" && name)
    : [];
  const parameters = { ...(request.parameters ?? {}) };
  for (const name of runtimeValueNames) {
    if (Object.hasOwn(parameters, name)) parameters[name] = "";
  }
  if (!preserveLegacySingleForm) {
    return {
      ...materialized,
      parameters,
      parametersComplete: request.parametersComplete === false ? false : true,
    };
  }
  const explicitQueryNames = queryParameterNames(request);
  const retainedEmptyNames = new Set([
    ...explicitQueryNames,
    ...runtimeValueNames,
  ]);
  const hasEmptyExplicitQueryParameter = [...explicitQueryNames].some(
    (name) => parameters[name] === "",
  );
  return {
    ...materialized,
    parameters: Object.fromEntries(
      Object.entries(parameters).filter(([name, value]) => value !== "" || retainedEmptyNames.has(name)),
    ),
    ...(hasEmptyExplicitQueryParameter ? { parametersComplete: false } : {}),
  };
}

function materializeJspRequests(graph, pendingJspPages, contextsByPage, struts2RoutesByName) {
  for (const { page, requests, preserveLegacySingleForm } of pendingJspPages) {
    const contexts = contextsByPage.get(page.id) ?? [];
    for (const originalRequest of requests) {
      const request = materializedJspRequest(originalRequest, preserveLegacySingleForm);
      const edgeType = request.kind === "form" ? "submits_to" : request.kind === "link" ? "links_to" : "requests";
      const relative = Object.hasOwn(request, "relativeUrl");
      const targets = relative ? contexts : [{ routeUrl: request.url, topPageId: page.id }];
      for (const context of targets) {
        const owner = graph.nodes.get(context.topPageId) ?? page;
        const url = relative ? normalizeRequestUrl(request.relativeUrl, context.routeUrl) : request.url;
        if (!url) continue;
        addRoute(graph, owner, canonicalStruts2Request({ ...request, url }, struts2RoutesByName), edgeType);
      }
    }
  }
}

function materializeJspScripts(graph, pendingJspPages, contextsByPage, sourceFileByWebPath) {
  const loadingContextsByScript = new Map();
  for (const { page, scripts } of pendingJspPages) {
    for (const script of scripts) {
      const contexts = contextsByPage.get(page.id) ?? [];
      for (const context of contexts) {
        const scriptWebPath = Object.hasOwn(script, "relativePath")
          ? normalizeRequestUrl(script.relativePath, context.routeUrl)
          : script.path;
        const targetFile = sourceFileByWebPath.get(scriptWebPath);
        if (!targetFile) {
          graph.addWarning(`unresolved JSP script: ${scriptWebPath || script.path} at ${script.evidence.file}:${script.evidence.line}`);
          continue;
        }
        const topPage = graph.nodes.get(context.topPageId) ?? page;
        const scriptFile = fileNode(graph, targetFile);
        graph.addEdge({
          source: topPage.id,
          target: scriptFile.id,
          type: "loads_script",
          confidence: 1,
          reason: "JSP script src",
          evidence: [script.evidence],
        });
        const loadingContexts = loadingContextsByScript.get(scriptFile.id) ?? new Map();
        const key = `${context.routeUrl}\0${topPage.id}`;
        loadingContexts.set(key, { routeUrl: context.routeUrl, page: topPage });
        loadingContextsByScript.set(scriptFile.id, loadingContexts);
      }
    }
  }
  return loadingContextsByScript;
}

function materializeJavaScriptRequests(graph, pendingRequests, loadingContextsByScript, struts2RoutesByName) {
  for (const { sourceFile, request } of pendingRequests) {
    const loadingContexts = [...(loadingContextsByScript.get(sourceFile.id)?.values() ?? [])];
    if (!Object.hasOwn(request, "relativeUrl")) {
      const canonical = canonicalStruts2Request(request, struts2RoutesByName);
      addRoute(graph, sourceFile, canonical, "requests");
      continue;
    }
    if (loadingContexts.length === 0) {
      graph.addWarning(
        `unresolved relative JavaScript request: ${request.relativeUrl} at ${request.evidence.file}:${request.evidence.line}`,
      );
      continue;
    }
    for (const { routeUrl, page } of loadingContexts) {
      const url = normalizeRequestUrl(request.relativeUrl, routeUrl);
      if (!url) continue;
      const canonical = canonicalStruts2Request({
        ...request,
        url,
        contextPageId: page.id,
      }, struts2RoutesByName);
      addRoute(graph, sourceFile, canonical, "requests");
    }
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
      searchText: [
        file.path,
        type.name,
        type.fullName,
        ...(type.canonicalName ? [type.canonicalName] : []),
        type.extendsType,
        ...type.implementsTypes,
      ],
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

function materializeProperties(graph, record, sourceFile) {
  sourceFile.data = {
    ...sourceFile.data,
    properties: record.facts.entries,
  };
  sourceFile.evidence = record.facts.entries.map((entry) => entry.evidence);
  sourceFile.searchText = [...new Set([
    ...sourceFile.searchText,
    ...record.facts.entries.flatMap((entry) => [entry.key, entry.value]),
  ])];
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

function configuredOutcomeData(framework, name) {
  return {
    outcome: {
      framework,
      name,
      classification: "configured-candidate",
      codeEvidence: [],
    },
  };
}

function configuredNameCounts(outcomes) {
  const counts = new Map();
  for (const outcome of outcomes) {
    counts.set(outcome.name, (counts.get(outcome.name) ?? 0) + 1);
  }
  return counts;
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
      const routeTarget = {
        routeNode,
        targetClass: action.type,
        source: "Struts action mapping",
        evidence: action.evidence,
        dispatchParameter: action.parameter,
        framework: "struts1",
        configuredOutcomes: [],
      };
      resolverFacts.routeTargets.push(routeTarget);
      const nameCounts = configuredNameCounts(action.forwards);
      for (const forward of action.forwards) {
        const tileName = tileNameForPath(forward.path);
        if (tileName && tileDefinitionNames.has(tileName)) {
          const tile = tileNode(graph, tileName, forward.evidence);
          const outcomeEdge = graph.addEdge({
            source: routeNode.id,
            target: tile.id,
            type: "uses_tile",
            confidence: 1,
            reason: `Struts forward ${forward.name} resolves to Tiles definition`,
            evidence: [forward.evidence],
            data: configuredOutcomeData("struts1", forward.name),
          });
          routeTarget.configuredOutcomes.push({
            edgeId: outcomeEdge.id,
            name: forward.name,
            nameUnique: nameCounts.get(forward.name) === 1,
          });
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
        const outcomeEdge = graph.addEdge({
          source: routeNode.id,
          target: page.id,
          type: "forwards_to",
          confidence: 1,
          reason: `Struts forward ${forward.name}`,
          evidence: [forward.evidence],
          data: configuredOutcomeData("struts1", forward.name),
        });
        routeTarget.configuredOutcomes.push({
          edgeId: outcomeEdge.id,
          name: forward.name,
          nameUnique: nameCounts.get(forward.name) === 1,
        });
      }
    }
  }
  if (struts2) {
    for (const action of struts2.actions) {
      const routeNode = addRoute(graph, sourceFile, { url: action.url, evidence: action.evidence, source: "Struts 2 action", kind: "struts2" }, "contains");
      const routeTarget = {
        routeNode,
        targetClass: action.className,
        source: "Struts 2 action mapping",
        evidence: action.evidence,
        dispatchMethod: action.method,
        dispatchMethodExplicit: action.methodExplicit,
        framework: "struts2",
        configuredOutcomes: [],
      };
      resolverFacts.routeTargets.push(routeTarget);
      const nameCounts = configuredNameCounts(action.results);
      for (const result of action.results) {
        if (!result.path) continue;
        if (result.type.toLowerCase() === "redirectaction") {
          const actionName = (result.actionName || result.path).replace(/^\/+/, "");
          const targetNamespace = result.namespace || action.namespace;
          const prefix = targetNamespace && targetNamespace !== "/" ? `/${targetNamespace.replace(/^\/+|\/+$/g, "")}` : "";
          const extension = action.extension ?? ".action";
          const targetUrl = `${prefix}/${actionName}${actionName.toLowerCase().endsWith(extension.toLowerCase()) ? "" : extension}`.replace(/\/{2,}/g, "/");
          const targetRoute = graph.addNode({ type: "route", key: targetUrl, name: targetUrl, evidence: [result.evidence], searchText: [targetUrl, "Struts 2 redirectAction"] });
          const outcomeEdge = graph.addEdge({
            source: routeNode.id,
            target: targetRoute.id,
            type: "redirects_to",
            confidence: 1,
            reason: `Struts 2 redirectAction result ${result.name}`,
            evidence: [result.evidence],
            data: configuredOutcomeData("struts2", result.name),
          });
          routeTarget.configuredOutcomes.push({
            edgeId: outcomeEdge.id,
            name: result.name,
            nameUnique: nameCounts.get(result.name) === 1,
          });
          continue;
        }
        const page = pageNodeForPath(graph, result.path, result.evidence, pageFileByWebPath, [result.name, result.type]);
        const outcomeEdge = graph.addEdge({
          source: routeNode.id,
          target: page.id,
          type: "forwards_to",
          confidence: 1,
          reason: `Struts 2 result ${result.name}`,
          evidence: [result.evidence],
          data: configuredOutcomeData("struts2", result.name),
        });
        routeTarget.configuredOutcomes.push({
          edgeId: outcomeEdge.id,
          name: result.name,
          nameUnique: nameCounts.get(result.name) === 1,
        });
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

function compareEvidence(left, right) {
  return String(left.file ?? "").localeCompare(String(right.file ?? ""), "en")
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0)
    || String(left.snippet ?? "").localeCompare(String(right.snippet ?? ""), "en");
}

function uniqueEvidence(entries) {
  const byLocation = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.file !== "string" || !Number.isInteger(entry.line)) continue;
    const key = `${entry.file}\0${entry.line}\0${entry.column ?? 0}\0${entry.snippet ?? ""}`;
    if (!byLocation.has(key)) byLocation.set(key, entry);
  }
  return [...byLocation.values()].sort(compareEvidence);
}

function classifyStrutsOutcomes(graph, resolverFacts) {
  const typesByNodeId = new Map();
  const methodsByNodeId = new Map();
  for (const javaFile of resolverFacts.javaFiles) {
    for (const type of javaFile.types) {
      const typeRecords = typesByNodeId.get(type.node.id) ?? [];
      typeRecords.push(type);
      typesByNodeId.set(type.node.id, typeRecords);
      for (const method of type.methods) {
        const methodRecords = methodsByNodeId.get(method.node.id) ?? [];
        methodRecords.push(method);
        methodsByNodeId.set(method.node.id, methodRecords);
      }
    }
  }
  const configuredOutcomeEdgeIds = new Set(
    resolverFacts.routeTargets
      .filter((routeTarget) => routeTarget.framework)
      .flatMap((routeTarget) => routeTarget.configuredOutcomes.map((outcome) => outcome.edgeId)),
  );
  for (const edgeId of configuredOutcomeEdgeIds) {
    const edge = graph.edges.get(edgeId);
    if (!edge?.data?.outcome) continue;
    edge.data.outcome = {
      ...edge.data.outcome,
      classification: "configured-candidate",
      codeEvidence: [],
    };
  }

  const strutsTargetsByRoute = new Map();
  for (const routeTarget of resolverFacts.routeTargets) {
    if (!routeTarget.framework) continue;
    const targets = strutsTargetsByRoute.get(routeTarget.routeNode.id) ?? [];
    targets.push(routeTarget);
    strutsTargetsByRoute.set(routeTarget.routeNode.id, targets);
  }

  for (const targets of strutsTargetsByRoute.values()) {
    if (targets.length !== 1) continue;
    const routeTarget = targets[0];
    const resolution = routeTarget.resolutionByRouteId?.get(routeTarget.routeNode.id);
    if (!resolution
      || resolution.mappedTypeIds.size !== 1
      || resolution.mappingEdgeIds.size !== 1
      || resolution.dispatchedMethodIds.size !== 1
      || resolution.dispatchEdgeIds.size !== 1) continue;
    const mappedTypes = typesByNodeId.get([...resolution.mappedTypeIds][0]) ?? [];
    const dispatchedMethods = methodsByNodeId.get([...resolution.dispatchedMethodIds][0]) ?? [];
    if (mappedTypes.length !== 1
      || (mappedTypes[0].topLevel === false && mappedTypes[0].staticMember !== true)
      || dispatchedMethods.length !== 1) continue;
    const dispatchedMethod = dispatchedMethods[0];

    const expectedKind = routeTarget.framework === "struts1"
      ? "struts1-find-forward"
      : "string-literal";
    const returnedResults = (dispatchedMethod.returnedResults ?? [])
      .filter((result) => result.kind === expectedKind);

    for (const configured of routeTarget.configuredOutcomes) {
      if (!configured.nameUnique || !isValidOutcomeName(configured.name)) continue;
      const matches = returnedResults.filter((result) => result.name === configured.name);
      if (matches.length === 0) continue;
      const edge = graph.edges.get(configured.edgeId);
      if (!edge?.data?.outcome) continue;
      edge.data.outcome = {
        ...edge.data.outcome,
        classification: "code-confirmed",
        codeEvidence: uniqueEvidence(matches.map((result) => result.evidence)),
      };
    }
  }
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
  const pendingJspPages = [];
  const javaScriptRequests = [];
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
      materializeJsp(graph, record, file, sourceFile, pageFileByWebPath, pendingJspPages);
    } else if (record.parserKind === "javascript") {
      for (const request of record.facts.requests) javaScriptRequests.push({ sourceFile, request });
    } else if (record.parserKind === "java") {
      materializeJava(graph, record, file, sourceFile, resolverFacts);
    } else if (record.parserKind === "xml") {
      materializeXml(graph, record, file, sourceFile, resolverFacts, pageFileByWebPath, tileDefinitionNames);
    } else if (record.parserKind === "sql") {
      materializeSql(graph, record, file, sourceFile, resolverFacts);
    } else if (record.parserKind === "properties") {
      materializeProperties(graph, record, sourceFile);
    }
  }

  // Discover arrivals on the resolved graph, then rebuild resolver edges after browser hints exist.
  const preResolutionEdgeIds = new Set(graph.edges.keys());
  const preResolutionWarningCount = graph.warnings.length;
  resolveFacts(graph, resolverFacts);
  const contextsByPage = pageArrivalContexts(graph);
  for (const edgeId of graph.edges.keys()) {
    if (!preResolutionEdgeIds.has(edgeId)) graph.edges.delete(edgeId);
  }
  graph.warnings.length = preResolutionWarningCount;
  materializeJspRequests(graph, pendingJspPages, contextsByPage, struts2RoutesByName);
  const loadingContextsByScript = materializeJspScripts(
    graph,
    pendingJspPages,
    contextsByPage,
    sourceFileByWebPath,
  );
  materializeJavaScriptRequests(graph, javaScriptRequests, loadingContextsByScript, struts2RoutesByName);
  resolveFacts(graph, resolverFacts);
  classifyStrutsOutcomes(graph, resolverFacts);
  return graph.toJSON();
}
