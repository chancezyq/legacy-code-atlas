function append(index, key, value) {
  const values = index.get(key);
  if (values) {
    values.push(value);
    return values;
  }
  const created = [value];
  index.set(key, created);
  return created;
}

function appendOwner(index, javaFile, owner, value) {
  let byOwner = index.get(javaFile);
  if (!byOwner) {
    byOwner = new Map();
    index.set(javaFile, byOwner);
  }
  append(byOwner, owner, value);
}

export function buildResolverIndexes(graph, facts) {
  const indexes = {
    typesByFull: new Map(),
    typesBySimple: new Map(),
    methodsByType: new Map(),
    methodsByName: new Map(),
    methodsByTypeAndName: new Map(),
    methodsByRecordAndName: new Map(),
    javaFileByTypeRecord: new Map(),
    fieldsByOwner: new Map(),
    callsByOwner: new Map(),
    statementUsesByOwner: new Map(),
    fieldsByJavaFile: new Map(),
    localVariablesByJavaFile: new Map(),
    callsByJavaFile: new Map(),
    statementUsesByJavaFile: new Map(),
    statementsByFull: new Map(),
    statementsByShort: new Map(),
    proceduresByFull: new Map(),
    proceduresByShort: new Map(),
    springBeansById: new Map(),
    routeNodes: [],
    routesByExactName: new Map(),
  };

  for (const javaFile of facts.javaFiles) {
    for (const typeRecord of javaFile.types) {
      // Preserve the old last-record-wins behavior for duplicate fully qualified IDs.
      indexes.typesByFull.set(typeRecord.fullName, [typeRecord]);
      append(indexes.typesBySimple, typeRecord.name, typeRecord);
      indexes.methodsByType.set(typeRecord.node.id, typeRecord.methods);
      const methodsByName = new Map();
      for (const method of typeRecord.methods) {
        append(indexes.methodsByName, method.name, method);
        append(methodsByName, method.name, method);
      }
      indexes.methodsByRecordAndName.set(typeRecord, methodsByName);
      indexes.javaFileByTypeRecord.set(typeRecord, javaFile);
    }
    for (const field of javaFile.fields) {
      append(indexes.fieldsByOwner, field.ownerType, field);
      appendOwner(indexes.fieldsByJavaFile, javaFile, field.ownerType, field);
    }
    for (const localVariable of javaFile.localVariables ?? []) {
      appendOwner(indexes.localVariablesByJavaFile, javaFile, localVariable.ownerType, localVariable);
    }
    for (const call of javaFile.calls) {
      append(indexes.callsByOwner, call.ownerType, call);
      appendOwner(indexes.callsByJavaFile, javaFile, call.ownerType, call);
    }
    for (const statementUse of javaFile.statementUses) {
      append(indexes.statementUsesByOwner, statementUse.ownerType, statementUse);
      appendOwner(indexes.statementUsesByJavaFile, javaFile, statementUse.ownerType, statementUse);
    }
  }

  for (const [typeId, methods] of indexes.methodsByType) {
    for (const method of methods) append(indexes.methodsByTypeAndName, `${typeId}|${method.name}`, method);
  }

  for (const statement of facts.statements) {
    // Preserve the old last-record-wins behavior for duplicate full statement IDs.
    indexes.statementsByFull.set(statement.fullId, statement);
    append(indexes.statementsByShort, statement.id, statement);
  }

  for (const procedure of facts.procedures ?? []) {
    // SQL source archives commonly contain repeated ALTER definitions. Keep deterministic last-record resolution.
    indexes.proceduresByFull.set(procedure.fullName, procedure);
    append(indexes.proceduresByShort, procedure.name, procedure);
  }

  for (const bean of facts.springBeans ?? []) {
    append(indexes.springBeansById, bean.id, bean);
  }

  indexes.routeNodes = [...graph.nodes.values()].filter((node) => node.type === "route");
  for (const routeNode of indexes.routeNodes) append(indexes.routesByExactName, routeNode.name, routeNode);

  return indexes;
}
