import { buildResolverIndexes } from "./resolver-indexes.mjs";

function simpleName(typeName) {
  return String(typeName ?? "").replace(/<.*>/g, "").split(".").at(-1);
}

function candidatesForType(indexes, typeName, context = null) {
  if (!typeName) return [];
  const direct = indexes.typesByFull.get(typeName);
  if (direct) return direct;
  const simple = simpleName(typeName);
  if (context) {
    const explicitImport = context.imports?.find((importName) => importName.endsWith(`.${simple}`));
    if (explicitImport && indexes.typesByFull.has(explicitImport)) return indexes.typesByFull.get(explicitImport);
    const samePackage = context.packageName ? `${context.packageName}.${simple}` : "";
    if (samePackage && indexes.typesByFull.has(samePackage)) return indexes.typesByFull.get(samePackage);
    const wildcardPrefixes = (context.imports ?? []).filter((importName) => importName.endsWith(".*")).map((importName) => importName.slice(0, -2));
    const wildcardMatches = (indexes.typesBySimple.get(simple) ?? []).filter((record) => wildcardPrefixes.some((prefix) => record.fullName.startsWith(`${prefix}.`)));
    if (wildcardMatches.length) return wildcardMatches;
  }
  return indexes.typesBySimple.get(simple) ?? [];
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
  return candidatesForType(indexes, typeRecord.extendsType, indexes.javaFileByTypeRecord.get(typeRecord));
}

function inheritedEntryMethods(indexes, typeRecord, entryNames) {
  const visited = new Set([typeRecord]);
  let frontier = parentTypes(indexes, typeRecord).filter((parent) => !visited.has(parent));
  while (frontier.length) {
    for (const parent of frontier) visited.add(parent);
    const entries = frontier.flatMap((parent) => entryNames.flatMap((name) => methodsNamed(indexes, parent.node.id, name)
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

export function resolveFacts(graph, facts) {
  const indexes = buildResolverIndexes(graph, facts);

  for (const routeTarget of facts.routeTargets) {
    const routePattern = routeTarget.routeNode.name;
    const mappedRoutes = routePattern === routePattern.replace(/\*+$/, "")
      ? indexes.routesByExactName.get(routePattern) ?? []
      : indexes.routeNodes.filter((node) => routeMatches(routePattern, node.name));
    const directTargetTypes = candidatesForType(indexes, routeTarget.targetClass);
    const springBeans = directTargetTypes.length === 0
      ? indexes.springBeansById.get(routeTarget.targetClass) ?? []
      : [];
    const springClasses = [...new Set(springBeans.map((bean) => bean.className).filter(Boolean))];
    const ambiguousSpringBean = springClasses.length > 1;
    const springBean = springClasses.length === 1 ? springBeans[0] : null;
    const resolvedTargetClass = springBean?.className ?? routeTarget.targetClass;
    const targetTypes = candidatesForType(indexes, resolvedTargetClass);
    if (ambiguousSpringBean) {
      graph.addWarning(`ambiguous Spring bean route target: ${routeTarget.routeNode.name} -> ${routeTarget.targetClass}`);
    }
    if (targetTypes.length === 0 && !ambiguousSpringBean) {
      graph.addWarning(`unresolved route target: ${routeTarget.routeNode.name} -> ${routeTarget.targetClass}`);
    }
    for (const targetType of targetTypes) {
      for (const mappedRoute of mappedRoutes) {
        graph.addEdge({
          source: mappedRoute.id,
          target: targetType.node.id,
          type: "maps_to",
          confidence: targetType.fullName === resolvedTargetClass ? 1 : 0.8,
          reason: springBean ? `${routeTarget.source} via Spring bean ${routeTarget.targetClass}` : routeTarget.source,
          evidence: [routeTarget.evidence, ...springBeans.flatMap((bean) => bean.node.evidence ?? []), ...mappedRoute.evidence, ...targetType.node.evidence],
        });
        const hints = mappedRoute.data.requestHints ?? [];
        const requestedMethods = routeTarget.dispatchParameter
          ? hints.map((hint) => hint.parameters?.[routeTarget.dispatchParameter]).filter((value) => value && !value.includes("${"))
          : [];
        let entryNames = routeTarget.dispatchMethodExplicit ? [routeTarget.dispatchMethod] : [...new Set(requestedMethods)];
        let dispatchReason = routeTarget.dispatchMethodExplicit
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
          entryNames = ["execute", "perform"];
          dispatchReason = "Action entry convention";
        }
        const directEntryMethods = entryNames.flatMap((name) => methodsNamed(indexes, targetType.node.id, name)
          .map((method) => ({ method, owner: targetType })));
        const inheritedEntries = directEntryMethods.length > 0
          ? []
          : inheritedEntryMethods(indexes, targetType, entryNames);
        const entryMethods = directEntryMethods.length > 0 ? directEntryMethods : inheritedEntries;
        if (inheritedEntries.length > 0) {
          dispatchReason = `Inherited ${dispatchReason}`;
        }
        for (const entry of entryMethods) {
          const entryMethod = entry.method;
          graph.addEdge({
            source: mappedRoute.id,
            target: entryMethod.node.id,
            type: "dispatches_to",
            confidence: requestedMethods.includes(entryMethod.name) || routeTarget.dispatchMethodExplicit ? 1 : 0.9,
            reason: dispatchReason,
            evidence: [routeTarget.evidence, ...mappedRoute.evidence, ...entryMethod.node.evidence],
          });
          if (inheritedEntries.length > 0) {
            for (const handler of inheritedTemplateHandlers(indexes, targetType, entry)) {
              graph.addEdge({
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
        const contracts = candidatesForType(indexes, declaredInterface, javaFile);
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
        ).flatMap((type) => methodsNamed(indexes, type.node.id, call.method)));
        let targets = call.receiverMethod
          ? methodReturnTargets
          : receiverType
            ? candidatesForType(indexes, receiverType, javaFile).flatMap((type) => methodsNamed(indexes, type.node.id, call.method))
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
