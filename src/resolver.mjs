import { buildResolverIndexes } from "./resolver-indexes.mjs";

function sourceTypeName(typeName) {
  return String(typeName ?? "")
    .replace(/<.*>/g, "")
    .replace(/(?:\s*\[\s*\])+$/gu, "")
    .trim();
}

function simpleName(typeName) {
  return sourceTypeName(typeName).split(".").at(-1);
}

function globallyVisibleTypes(records) {
  return records.filter((type) => type.topLevel !== false);
}

function enclosingType(indexes, typeRecord) {
  if (!typeRecord || typeRecord.topLevel !== false) return null;
  if (typeRecord.canonicalName && typeRecord.name) {
    const suffix = `.${typeRecord.name}`;
    if (typeRecord.canonicalName.endsWith(suffix)) {
      const parentCanonical = typeRecord.canonicalName.slice(0, -suffix.length);
      const canonicalParent = indexes.typesByCanonical.get(parentCanonical)?.[0];
      if (canonicalParent) return canonicalParent;
    }
  }
  const syntheticOffset = ["$local$", "$nested$"]
    .map((marker) => typeRecord.fullName.indexOf(marker))
    .filter((offset) => offset !== -1)
    .sort((left, right) => left - right)[0];
  if (syntheticOffset === undefined) return null;
  return indexes.typesByFull.get(typeRecord.fullName.slice(0, syntheticOffset))?.[0] ?? null;
}

function lexicalTypeCandidates(indexes, sourceName, ownerType, includeInherited) {
  const visited = new Set();
  let current = ownerType;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.canonicalName) {
      const candidates = indexes.typesByCanonical.get(`${current.canonicalName}.${sourceName}`);
      if (candidates) return candidates;
    }
    if (includeInherited) {
      const inherited = inheritedMemberTypeCandidates(indexes, sourceName, current);
      if (inherited.length) return inherited;
    }
    current = enclosingType(indexes, current);
  }
  return [];
}

function headerTypeCandidates(indexes, typeName, typeRecord) {
  return candidatesForType(
    indexes,
    typeName,
    indexes.javaFileByTypeRecord.get(typeRecord),
    enclosingType(indexes, typeRecord),
    true,
  );
}

function directSuperTypes(indexes, typeRecord) {
  const candidates = [typeRecord?.extendsType, ...(typeRecord?.implementsTypes ?? [])]
    .filter(Boolean)
    .flatMap((declaredType) => headerTypeCandidates(indexes, declaredType, typeRecord));
  return [...new Set(candidates)];
}

function inheritedMemberTypeCandidates(indexes, sourceName, ownerType) {
  const visited = new Set(ownerType ? [ownerType] : []);
  let frontier = directSuperTypes(indexes, ownerType);
  while (frontier.length) {
    const level = [...new Set(frontier)].filter((type) => !visited.has(type));
    for (const type of level) visited.add(type);
    const matches = [];
    const seenMatches = new Set();
    for (const type of level) {
      if (!type.canonicalName) continue;
      for (const match of indexes.typesByCanonical.get(`${type.canonicalName}.${sourceName}`) ?? []) {
        if (seenMatches.has(match)) continue;
        seenMatches.add(match);
        matches.push(match);
      }
    }
    if (matches.length) return matches;
    frontier = level.flatMap((type) => directSuperTypes(indexes, type));
  }
  return [];
}

function candidatesForType(indexes, typeName, context = null, ownerType = null, includeInherited = true) {
  if (!typeName) return [];
  const sourceName = sourceTypeName(typeName);
  const direct = indexes.typesByFull.get(sourceName);
  if (direct) return direct;
  const canonical = indexes.typesByCanonical.get(sourceName);
  if (canonical) return canonical;
  const simple = simpleName(sourceName);
  if (context) {
    const lexical = lexicalTypeCandidates(indexes, sourceName, ownerType, includeInherited);
    if (lexical.length) return lexical;
    const [importedRoot, ...memberPath] = sourceName.split(".");
    const explicitImport = context.imports?.find((importName) => importName.endsWith(`.${importedRoot}`));
    const importedName = explicitImport
      ? [explicitImport, ...memberPath].join(".")
      : "";
    const imported = importedName
      ? indexes.typesByCanonical.get(importedName) ?? indexes.typesByFull.get(importedName)
      : null;
    if (imported) return imported;
    const samePackage = context.packageName ? `${context.packageName}.${sourceName}` : "";
    const packaged = samePackage
      ? indexes.typesByCanonical.get(samePackage) ?? indexes.typesByFull.get(samePackage)
      : null;
    if (packaged) return packaged;
    const wildcardPrefixes = (context.imports ?? []).filter((importName) => importName.endsWith(".*")).map((importName) => importName.slice(0, -2));
    const wildcardMatches = [];
    const seenWildcardTypes = new Set();
    for (const prefix of wildcardPrefixes) {
      const importedName = `${prefix}.${sourceName}`;
      const importedRecords = indexes.typesByCanonical.get(importedName)
        ?? indexes.typesByFull.get(importedName)
        ?? [];
      for (const record of importedRecords) {
        if (seenWildcardTypes.has(record)) continue;
        seenWildcardTypes.add(record);
        wildcardMatches.push(record);
      }
    }
    if (wildcardMatches.length) return wildcardMatches;
  }
  return globallyVisibleTypes(indexes.typesBySimple.get(simple) ?? []);
}

function routeCandidatesForType(indexes, typeName) {
  const exact = indexes.typesByFull.get(typeName);
  const candidates = exact ?? (String(typeName ?? "").includes(".") ? [] : candidatesForType(indexes, typeName));
  return candidates.filter((type) => (
    (!type.kind || type.kind === "class")
    && (
      type.topLevel !== false
      || (type.staticMember === true && type.fullName === typeName)
    )
  ));
}

function methodsNamed(indexes, typeId, methodName) {
  return indexes.methodsByTypeAndName.get(`${typeId}|${methodName}`) ?? [];
}

function recordMethodsNamed(indexes, typeRecord, methodName, methodArity, methodSignature) {
  const methods = indexes.methodsByRecordAndName.get(typeRecord)?.get(methodName) ?? [];
  if (methodSignature) {
    const signedMethods = methods.filter((method) => method.methodSignature);
    if (signedMethods.length) {
      const exact = signedMethods.filter((method) => method.methodSignature === methodSignature);
      if (exact.length) return exact;
      const simpleSignature = simpleMethodSignature(methodSignature);
      const simpleMatches = signedMethods.filter((method) => simpleMethodSignature(method.methodSignature) === simpleSignature);
      return simpleMatches.length === 1 ? simpleMatches : [];
    }
  }
  return Number.isInteger(methodArity) ? methods.filter((method) => method.arity === methodArity) : methods;
}

function simpleMethodSignature(methodSignature) {
  return String(methodSignature ?? "").replace(/(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)/g, "$1");
}

function isStruts1EntryMethod(method) {
  return method.visibility === "public"
    && simpleName(method.returnType) === "ActionForward"
    && simpleMethodSignature(method.methodSignature)
      === "ActionMapping,ActionForm,HttpServletRequest,HttpServletResponse";
}

function matchingImplementations(implementationCandidates, contractMethod) {
  if (!contractMethod.methodSignature) return implementationCandidates;
  const signedCandidates = implementationCandidates.filter((method) => method.methodSignature);
  if (signedCandidates.length === 0) return implementationCandidates;
  const exact = signedCandidates.filter((method) => method.methodSignature === contractMethod.methodSignature);
  if (exact.length) return exact;
  const simpleSignature = simpleMethodSignature(contractMethod.methodSignature);
  const simpleMatches = signedCandidates.filter((method) => simpleMethodSignature(method.methodSignature) === simpleSignature);
  return simpleMatches.length === 1 ? simpleMatches : [];
}

function compareEvidencePosition(left, right) {
  const leftLine = left?.line;
  const rightLine = right?.line;
  const leftColumn = left?.column;
  const rightColumn = right?.column;
  if (![leftLine, rightLine, leftColumn, rightColumn].every(Number.isInteger)) return null;
  if (left?.file && right?.file && left.file !== right.file) return null;
  return leftLine - rightLine || leftColumn - rightColumn;
}

function localVariableType(localVariables, call, receiverName) {
  let selected = null;
  for (const localVariable of localVariables) {
    if (localVariable.enclosingMethod !== call.enclosingMethod || localVariable.name !== receiverName) continue;
    if (Number.isInteger(call.enclosingMethodArity)
      && localVariable.enclosingMethodArity !== call.enclosingMethodArity) continue;
    if (call.enclosingMethodSignature
      && localVariable.enclosingMethodSignature
      && localVariable.enclosingMethodSignature !== call.enclosingMethodSignature) continue;
    const beforeCall = compareEvidencePosition(localVariable.evidence, call.evidence);
    if (beforeCall !== null && beforeCall > 0) continue;
    if (!selected) {
      selected = localVariable;
      continue;
    }
    const afterSelected = compareEvidencePosition(localVariable.evidence, selected.evidence);
    if (afterSelected === null || afterSelected >= 0) selected = localVariable;
  }
  return selected?.type ?? "";
}

function routeMatches(pattern, url) {
  if (pattern === url) return true;
  if (pattern === "/*") return url.startsWith("/");
  if (pattern.endsWith("/*")) return url.startsWith(pattern.slice(0, -1));
  return false;
}

function parentTypes(indexes, typeRecord) {
  if (!typeRecord?.extendsType) return [];
  return headerTypeCandidates(indexes, typeRecord.extendsType, typeRecord);
}

function inheritedEntryMethods(indexes, typeRecord, entryNames, acceptsMethod = () => true) {
  const visited = new Set([typeRecord]);
  let frontier = parentTypes(indexes, typeRecord).filter((parent) => !visited.has(parent));
  while (frontier.length) {
    for (const parent of frontier) visited.add(parent);
    const entries = frontier.flatMap((parent) => entryNames.flatMap((name) => methodsNamed(indexes, parent.node.id, name)
      .filter(acceptsMethod)
      .map((method) => ({ method, owner: parent }))));
    if (entries.length) return entries;
    frontier = frontier
      .flatMap((parent) => parentTypes(indexes, parent))
      .filter((parent) => !visited.has(parent));
  }
  return [];
}

function templateMethodName(entryName) {
  if (entryName === "execute") return "doExecute";
  if (entryName === "perform") return "doPerform";
  return "";
}

function inheritedTemplateHandlers(indexes, targetType, inheritedEntry) {
  const templateName = templateMethodName(inheritedEntry.method.name);
  if (!templateName) return [];
  const parentTemplates = methodsNamed(indexes, inheritedEntry.owner.node.id, templateName)
    .filter((method) => method.arity === inheritedEntry.method.arity);
  if (parentTemplates.length === 0) return [];
  const matchingParentTemplates = matchingImplementations(parentTemplates, inheritedEntry.method);
  const templateContracts = matchingParentTemplates.length ? matchingParentTemplates : parentTemplates;
  const visited = new Set();
  let frontier = [targetType];
  while (frontier.length) {
    const childMethods = frontier.flatMap((type) => methodsNamed(indexes, type.node.id, templateName))
      .filter((method) => method.arity === inheritedEntry.method.arity);
    const handlers = templateContracts.flatMap((contract) => matchingImplementations(childMethods, contract));
    if (handlers.length) {
      const seen = new Set();
      return handlers
        .filter((method) => {
          if (seen.has(method.node.id)) return false;
          seen.add(method.node.id);
          return true;
        })
        .map((method) => ({
          method,
          parentTemplate: templateContracts.find((contract) => matchingImplementations([method], contract).length > 0) ?? templateContracts[0],
        }));
    }
    for (const type of frontier) visited.add(type);
    frontier = frontier
      .filter((type) => type !== inheritedEntry.owner)
      .flatMap((type) => parentTypes(indexes, type))
      .filter((type) => !visited.has(type) && type !== inheritedEntry.owner);
  }
  return [];
}

function procedureCandidates(indexes, name) {
  const exact = indexes.proceduresByFull.get(name);
  if (exact) return { exact: true, records: [exact] };
  const short = String(name ?? "").split(".").at(-1);
  return { exact: false, records: indexes.proceduresByShort.get(short) ?? [] };
}

function routeTargetResolution(routeTarget, routeId) {
  let resolution = routeTarget.resolutionByRouteId.get(routeId);
  if (!resolution) {
    resolution = {
      mappedTypeIds: new Set(),
      mappingEdgeIds: new Set(),
      dispatchedMethodIds: new Set(),
      dispatchEdgeIds: new Set(),
    };
    routeTarget.resolutionByRouteId.set(routeId, resolution);
  }
  return resolution;
}

export function resolveFacts(graph, facts) {
  const indexes = buildResolverIndexes(graph, facts);

  for (const routeTarget of facts.routeTargets) {
    routeTarget.resolutionByRouteId = new Map();
    const routePattern = routeTarget.routeNode.name;
    const mappedRoutes = routePattern === routePattern.replace(/\*+$/, "")
      ? indexes.routesByExactName.get(routePattern) ?? []
      : indexes.routeNodes.filter((node) => routeMatches(routePattern, node.name));
    const directTargetTypes = routeCandidatesForType(indexes, routeTarget.targetClass);
    const springBeans = directTargetTypes.length === 0
      ? indexes.springBeansById.get(routeTarget.targetClass) ?? []
      : [];
    const springClasses = [...new Set(springBeans.map((bean) => bean.className).filter(Boolean))];
    const ambiguousSpringBean = springClasses.length > 1;
    const springBean = springClasses.length === 1 ? springBeans[0] : null;
    const resolvedTargetClass = springBean?.className ?? routeTarget.targetClass;
    const targetTypes = routeCandidatesForType(indexes, resolvedTargetClass);
    if (ambiguousSpringBean) {
      graph.addWarning(`ambiguous Spring bean route target: ${routeTarget.routeNode.name} -> ${routeTarget.targetClass}`);
    }
    if (targetTypes.length === 0 && !ambiguousSpringBean) {
      graph.addWarning(`unresolved route target: ${routeTarget.routeNode.name} -> ${routeTarget.targetClass}`);
    }
    for (const targetType of targetTypes) {
      for (const mappedRoute of mappedRoutes) {
        const resolution = routeTargetResolution(routeTarget, mappedRoute.id);
        const mappingEdge = graph.addEdge({
          source: mappedRoute.id,
          target: targetType.node.id,
          type: "maps_to",
          confidence: targetType.fullName === resolvedTargetClass ? 1 : 0.8,
          reason: springBean ? `${routeTarget.source} via Spring bean ${routeTarget.targetClass}` : routeTarget.source,
          evidence: [routeTarget.evidence, ...springBeans.flatMap((bean) => bean.node.evidence ?? []), ...mappedRoute.evidence, ...targetType.node.evidence],
        });
        resolution.mappedTypeIds.add(targetType.node.id);
        resolution.mappingEdgeIds.add(mappingEdge.id);
        const hints = mappedRoute.data.requestHints ?? [];
        const requestedMethods = routeTarget.dispatchParameter
          ? hints.map((hint) => hint.parameters?.[routeTarget.dispatchParameter]).filter((value) => value && !value.includes("${"))
          : [];
        const dynamicMethods = routeTarget.framework === "struts2"
          ? hints.map((hint) => hint.dispatchMethod).filter((value) => typeof value === "string" && value)
          : [];
        const hasOrdinaryStruts2Request = routeTarget.framework === "struts2"
          && dynamicMethods.length > 0
          && hints.some((hint) => typeof hint.dispatchMethod !== "string" || !hint.dispatchMethod);
        let entryNames = dynamicMethods.length > 0
          ? [...new Set([
            ...dynamicMethods,
            ...(hasOrdinaryStruts2Request
              ? [routeTarget.dispatchMethodExplicit ? routeTarget.dispatchMethod : "execute"]
              : []),
          ])]
          : routeTarget.dispatchMethodExplicit
          ? [routeTarget.dispatchMethod]
          : [...new Set(requestedMethods)];
        let dispatchReason = dynamicMethods.length > 0
          ? hasOrdinaryStruts2Request
            ? routeTarget.dispatchMethodExplicit
              ? "Struts 2 dynamic/configured method"
              : "Struts 2 dynamic/default method"
            : "Struts 2 dynamic method"
          : routeTarget.dispatchMethodExplicit
          ? "Struts 2 action method"
          : routeTarget.dispatchParameter ? `Struts parameter ${routeTarget.dispatchParameter}` : "";
        if (entryNames.length === 0 && routeTarget.source === "servlet") {
          entryNames = [...new Set(hints.map((hint) => hint.method === "POST" ? "doPost" : hint.method === "GET" ? "doGet" : "service"))];
          if (entryNames.length === 0) {
            entryNames = ["service"];
            dispatchReason = "Servlet service convention";
          } else {
            dispatchReason = "Servlet HTTP method";
          }
        }
        if (entryNames.length === 0 && /Spring/i.test(routeTarget.source)) {
          entryNames = ["handleRequest", "handleRequestInternal"];
          dispatchReason = "Spring legacy controller convention";
        }
        if (entryNames.length === 0 && routeTarget.source !== "servlet" && !/DispatchAction$/.test(targetType.extendsType)) {
          entryNames = routeTarget.framework === "struts2" ? ["execute"] : ["execute", "perform"];
          dispatchReason = "Action entry convention";
        }
        const acceptsEntryMethod = (method) => {
          if (routeTarget.framework === "struts1") return isStruts1EntryMethod(method);
          if (routeTarget.framework === "struts2") {
            return method.visibility === "public" && method.arity === 0;
          }
          return true;
        };
        const directEntryMethods = entryNames.flatMap((name) => methodsNamed(indexes, targetType.node.id, name)
          .filter(acceptsEntryMethod)
          .map((method) => ({ method, owner: targetType, inherited: false })));
        const directEntryNames = new Set(directEntryMethods.map((entry) => entry.method.name));
        const inheritedEntries = entryNames
          .filter((name) => !directEntryNames.has(name))
          .flatMap((name) => inheritedEntryMethods(indexes, targetType, [name], acceptsEntryMethod)
            .map((entry) => ({ ...entry, inherited: true })));
        const entryMethods = [...directEntryMethods, ...inheritedEntries];
        for (const entry of entryMethods) {
          const entryMethod = entry.method;
          const entryDispatchReason = entry.inherited ? `Inherited ${dispatchReason}` : dispatchReason;
          const dispatchEdge = graph.addEdge({
            source: mappedRoute.id,
            target: entryMethod.node.id,
            type: "dispatches_to",
            confidence: requestedMethods.includes(entryMethod.name)
              || dynamicMethods.includes(entryMethod.name)
              || routeTarget.dispatchMethodExplicit ? 1 : 0.9,
            reason: entryDispatchReason,
            evidence: [routeTarget.evidence, ...mappedRoute.evidence, ...entryMethod.node.evidence],
          });
          resolution.dispatchedMethodIds.add(entryMethod.node.id);
          resolution.dispatchEdgeIds.add(dispatchEdge.id);
          if (entry.inherited) {
            for (const handler of inheritedTemplateHandlers(indexes, targetType, entry)) {
              const handlerEdge = graph.addEdge({
                source: mappedRoute.id,
                target: handler.method.node.id,
                type: "dispatches_to",
                confidence: 0.9,
                reason: `Action template handler via inherited ${entryMethod.name}`,
                evidence: [
                  routeTarget.evidence,
                  ...mappedRoute.evidence,
                  ...entryMethod.node.evidence,
                  ...handler.parentTemplate.node.evidence,
                  ...handler.method.node.evidence,
                ],
              });
              resolution.dispatchedMethodIds.add(handler.method.node.id);
              resolution.dispatchEdgeIds.add(handlerEdge.id);
            }
          }
        }
        if (entryMethods.length === 0) {
          graph.addWarning(`unresolved route entry: ${mappedRoute.name} -> ${targetType.fullName}`);
        }
      }
    }
  }


  for (const statement of facts.statements) {
    if (!statement.procedureName) continue;
    const candidates = procedureCandidates(indexes, statement.procedureName);
    if (candidates.records.length === 0) {
      graph.addWarning(`unresolved SQL Server procedure: ${statement.procedureName} at ${statement.evidence.file}:${statement.evidence.line}`);
    }
    for (const procedure of candidates.records) {
      graph.addEdge({
        source: statement.node.id,
        target: procedure.node.id,
        type: "calls_procedure",
        confidence: candidates.exact ? 1 : candidates.records.length === 1 ? 0.8 : 0.5,
        reason: candidates.exact ? "iBATIS procedure call" : "iBATIS procedure short-name resolution",
        evidence: [statement.evidence, ...procedure.node.evidence],
      });
    }
  }

  for (const procedure of facts.procedures ?? []) {
    for (const calledName of procedure.calls) {
      const candidates = procedureCandidates(indexes, calledName);
      if (candidates.records.length === 0) {
        graph.addWarning(`unresolved SQL Server procedure call: ${procedure.fullName} -> ${calledName}`);
      }
      for (const called of candidates.records) {
        graph.addEdge({
          source: procedure.node.id,
          target: called.node.id,
          type: "calls",
          confidence: candidates.exact ? 1 : candidates.records.length === 1 ? 0.8 : 0.5,
          reason: candidates.exact ? "SQL Server EXEC" : "SQL Server EXEC short-name resolution",
          evidence: [procedure.evidence, ...called.node.evidence],
        });
      }
    }
  }

  for (const javaFile of facts.javaFiles) {
    for (const implementation of javaFile.types) {
      for (const declaredInterface of implementation.implementsTypes) {
        const contracts = headerTypeCandidates(indexes, declaredInterface, implementation);
        for (const contract of contracts) {
          const relationConfidence = contracts.length === 1 ? 1 : 0.5;
          const relationReason = contracts.length === 1 ? "Java implements declaration" : "ambiguous simple-name implements declaration";
          graph.addEdge({
            source: implementation.node.id,
            target: contract.node.id,
            type: "implements",
            confidence: relationConfidence,
            reason: relationReason,
            evidence: [...implementation.node.evidence, ...contract.node.evidence],
          });
          graph.addEdge({
            source: contract.node.id,
            target: implementation.node.id,
            type: "implemented_by",
            confidence: relationConfidence,
            reason: relationReason,
            evidence: [...implementation.node.evidence, ...contract.node.evidence],
          });
          for (const contractMethod of contract.methods) {
            const implementationCandidates = methodsNamed(indexes, implementation.node.id, contractMethod.name)
              .filter((implementationMethod) => implementationMethod.arity === contractMethod.arity);
            for (const implementationMethod of matchingImplementations(implementationCandidates, contractMethod)) {
              graph.addEdge({
                source: contractMethod.node.id,
                target: implementationMethod.node.id,
                type: "implemented_by",
                confidence: relationConfidence,
                reason: contracts.length === 1 ? "interface method implementation" : "ambiguous interface method implementation",
                evidence: [...contractMethod.node.evidence, ...implementationMethod.node.evidence],
              });
            }
          }
        }
      }
    }
  }

  const allMethods = indexes.methodsByName;
  for (const javaFile of facts.javaFiles) {
    for (const ownerType of javaFile.types) {
      const fieldsByName = new Map(
        (indexes.fieldsByJavaFile.get(javaFile)?.get(ownerType.fullName) ?? []).map((field) => [field.name, field.type]),
      );
      const localVariables = indexes.localVariablesByJavaFile.get(javaFile)?.get(ownerType.fullName) ?? [];
      for (const call of indexes.callsByJavaFile.get(javaFile)?.get(ownerType.fullName) ?? []) {
        const sourceMethods = recordMethodsNamed(indexes, ownerType, call.enclosingMethod, call.enclosingMethodArity, call.enclosingMethodSignature);
        const receiverName = call.receiver.split(".").at(-1);
        const localType = localVariableType(localVariables, call, receiverName);
        const fieldType = fieldsByName.get(receiverName) ?? "";
        const receiverType = localType || fieldType;
        const directReturnProviders = call.receiverMethod
          ? methodsNamed(indexes, ownerType.node.id, call.receiverMethod)
            .filter((method) => method.arity === 0)
            .map((method) => ({ method, owner: ownerType }))
          : [];
        const returnProviders = directReturnProviders.length > 0
          ? directReturnProviders
          : call.receiverMethod
            ? inheritedEntryMethods(indexes, ownerType, [call.receiverMethod])
              .filter((entry) => entry.method.arity === 0)
            : [];
        const methodReturnTargets = returnProviders.flatMap((provider) => candidatesForType(
          indexes,
          provider.method.returnType,
          indexes.javaFileByTypeRecord.get(provider.owner),
          provider.owner,
        ).flatMap((type) => methodsNamed(indexes, type.node.id, call.method)));
        let targets = call.receiverMethod
          ? methodReturnTargets
          : receiverType
            ? candidatesForType(indexes, receiverType, javaFile, ownerType).flatMap((type) => methodsNamed(indexes, type.node.id, call.method))
            : [];
        let confidence = 0.9;
        let reason = call.receiverMethod && returnProviders.length > 0
          ? `method return type ${returnProviders.map((provider) => provider.method.returnType).filter(Boolean).join(" or ")}`
          : localType
            ? `local variable type ${receiverType}`
            : fieldType
              ? `receiver field type ${receiverType}`
              : "";
        if (returnProviders.length > 1) confidence = 0.5;
        if (targets.length === 0 && !call.receiverMethod) {
          const sameName = allMethods.get(call.method) ?? [];
          if (sameName.length === 1) {
            targets = sameName;
            confidence = 0.5;
            reason = "unique method-name heuristic";
          }
        }
        for (const sourceMethod of sourceMethods) {
          for (const targetMethod of targets) {
            if (sourceMethod.node.id === targetMethod.node.id) continue;
            graph.addEdge({
              source: sourceMethod.node.id,
              target: targetMethod.node.id,
              type: "calls",
              confidence,
              reason,
              evidence: [
                call.evidence,
                ...returnProviders.flatMap((provider) => provider.method.node.evidence),
                ...targetMethod.node.evidence,
              ],
            });
          }
        }
      }

      for (const statementUse of indexes.statementUsesByJavaFile.get(javaFile)?.get(ownerType.fullName) ?? []) {
        const sourceMethods = recordMethodsNamed(indexes, ownerType, statementUse.enclosingMethod, statementUse.enclosingMethodArity, statementUse.enclosingMethodSignature);
        const exact = indexes.statementsByFull.get(statementUse.statementId);
        const candidates = exact ? [exact] : indexes.statementsByShort.get(statementUse.statementId) ?? [];
        if (candidates.length === 0) {
          graph.addWarning(`unresolved iBATIS statement: ${statementUse.statementId} at ${statementUse.evidence.file}:${statementUse.evidence.line}`);
        }
        for (const sourceMethod of sourceMethods) {
          sourceMethod.node.searchText = [...new Set([
            ...(sourceMethod.node.searchText ?? []),
            statementUse.statementId,
            statementUse.operation,
          ])];
          for (const statement of candidates) {
            const resolutionConfidence = statementUse.confidence ?? 1;
            const identifierConfidence = exact ? 1 : candidates.length === 1 ? 0.8 : 0.5;
            graph.addEdge({
              source: sourceMethod.node.id,
              target: statement.node.id,
              type: "uses_statement",
              confidence: Math.min(resolutionConfidence, identifierConfidence),
              reason: `${statementUse.resolution ?? "literal"} statement id via ${statementUse.operation}`,
              evidence: [statementUse.evidence, ...statement.node.evidence],
              data: { operation: statementUse.operation },
            });
          }
        }
      }
    }
  }

  return graph;
}
