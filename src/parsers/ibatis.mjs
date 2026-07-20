import { createEvidenceLocator } from "../evidence.mjs";
import { findXmlElements, parseXmlAttributes, withoutXmlComments, xmlStructureWarnings } from "./xml-utils.mjs";

const IDENTIFIER = String.raw`(?:\[[^\]]+\]|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:\[[^\]]+\]|[A-Za-z_][\w$#]*))*`;

export function normalizeTableName(value) {
  return value
    .replace(/[\[\]`"']/g, "")
    .replace(/\s*\.\s*/g, ".")
    .trim()
    .toLowerCase();
}

function matchesAfter(sql, keyword) {
  const pattern = new RegExp(`\\b${keyword}\\s+(${IDENTIFIER})`, "gi");
  return [...sql.matchAll(pattern)].map((match) => normalizeTableName(match[1]));
}

function sanitizeSql(sql) {
  let output = "";
  let state = "code";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "code") {
      if (character === "-" && next === "-") {
        output += "  ";
        index += 1;
        state = "line-comment";
      } else if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block-comment";
      } else if (character === "'") {
        output += " ";
        state = "string";
      } else output += character;
    } else if (state === "line-comment") {
      output += character === "\n" ? "\n" : " ";
      if (character === "\n") state = "code";
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += character === "\n" ? "\n" : " ";
    } else if (character === "'" && next === "'") {
      output += "  ";
      index += 1;
    } else if (character === "'") {
      output += " ";
      state = "code";
    } else output += character === "\n" ? "\n" : " ";
  }
  return output;
}

function tableAliases(sql) {
  const aliases = new Map();
  const reserved = new Set(["where", "join", "inner", "left", "right", "full", "cross", "on", "group", "order", "set", "union", "having", "option"]);
  const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENTIFIER})(?:\\s+(?:AS\\s+)?([A-Za-z_][\\w$]*))?`, "gi");
  for (const match of sql.matchAll(pattern)) {
    const table = normalizeTableName(match[1]);
    const alias = normalizeTableName(match[2] ?? "");
    if (alias && !reserved.has(alias)) aliases.set(alias, table);
  }
  return aliases;
}

export function extractSqlTables(sql, statementType) {
  const source = sanitizeSql(sql);
  const reads = new Set();
  const writes = new Set();
  const cteNames = new Set();
  const ctePattern = new RegExp(`(?:\\bWITH|,)\\s*(${IDENTIFIER})\\s+AS\\s*\\(`, "gi");
  for (const match of source.matchAll(ctePattern)) cteNames.add(normalizeTableName(match[1]));
  const aliases = tableAliases(source);
  const resolveAlias = (table) => aliases.get(table) ?? table;

  for (const table of matchesAfter(source, "FROM")) reads.add(table);
  for (const table of matchesAfter(source, "JOIN")) reads.add(table);

  const operationTypes = statementType === "statement"
    ? new Set(["update", "insert", "delete"])
    : new Set([statementType]);

  if (operationTypes.has("update")) {
    for (const match of source.matchAll(new RegExp(`\\bUPDATE\\s+(?!SET\\b)(${IDENTIFIER})`, "gi"))) {
      writes.add(resolveAlias(normalizeTableName(match[1])));
    }
    for (const table of matchesAfter(source, "MERGE\\s+INTO")) writes.add(resolveAlias(table));
    for (const match of source.matchAll(new RegExp(`\\bUSING\\s+(${IDENTIFIER})`, "gi"))) {
      reads.add(normalizeTableName(match[1]));
    }
  }
  if (operationTypes.has("insert")) {
    for (const table of matchesAfter(source, "INSERT\\s+INTO")) writes.add(resolveAlias(table));
  }
  if (operationTypes.has("delete")) {
    for (const table of matchesAfter(source, "DELETE\\s+FROM")) writes.add(resolveAlias(table));
    const aliasDeletePattern = new RegExp(`\\bDELETE\\s+(?!FROM\\b)(${IDENTIFIER})\\s+FROM\\b`, "gi");
    for (const match of source.matchAll(aliasDeletePattern)) {
      writes.add(resolveAlias(normalizeTableName(match[1])));
    }
  }

  for (const written of writes) reads.delete(written);
  for (const cteName of cteNames) reads.delete(cteName);
  return {
    reads: [...reads].filter(Boolean).sort((left, right) => left.localeCompare(right, "en")),
    writes: [...writes].filter(Boolean).sort((left, right) => left.localeCompare(right, "en")),
  };
}

function sqlText(inner) {
  return inner
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function rootNamespace(source) {
  const match = source.match(/<sqlMap(?=\s|>)([^>]*)>/i);
  return match ? parseXmlAttributes(match[1]).namespace ?? "" : "";
}

function referencedProcedure(sql) {
  const match = sanitizeSql(sql).match(new RegExp(`(?:\\{\\s*call|\\bcall|\\bexec(?:ute)?)\\s+(${IDENTIFIER})`, "i"));
  return match ? normalizeTableName(match[1]) : "";
}

function procedureSqlSource(inner) {
  return inner
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/<[^>]+>/g, (tag) => tag.replace(/[^\n]/g, " "));
}

function expandIncludes(inner, fragmentMap, seen = new Set()) {
  return inner.replace(/<include\b[^>]*\brefid\s*=\s*(["'])(.*?)\1[^>]*(?:\/\s*>|>[\s\S]*?<\/include\s*>)/gi, (_raw, _quote, refid) => {
    const shortId = refid.split(".").at(-1);
    const fragment = fragmentMap.get(refid) ?? fragmentMap.get(shortId);
    if (!fragment || seen.has(refid)) return " ";
    return expandIncludes(fragment, fragmentMap, new Set([...seen, refid]));
  });
}

export function parseIbatisSqlMap(content, filePath) {
  const source = withoutXmlComments(content);
  const locator = createEvidenceLocator(source, filePath);
  const namespace = rootNamespace(source);
  const fragmentElements = findXmlElements(source, "sql", filePath, locator);
  const fragmentMap = new Map();
  for (const element of fragmentElements) {
    const id = element.attributes.id ?? "";
    if (!id) continue;
    fragmentMap.set(id, element.inner);
    if (namespace) fragmentMap.set(`${namespace}.${id}`, element.inner);
  }
  const fragments = fragmentElements.map((element) => ({
      id: element.attributes.id ?? "",
      sql: sqlText(element.inner),
      evidence: element.evidence,
      offset: element.offset,
    }))
    .filter((fragment) => fragment.id)
    .sort((left, right) => left.offset - right.offset)
    .map(({ offset: _offset, ...fragment }) => fragment);

  const statements = [];
  const warnings = xmlStructureWarnings(content, filePath, "sqlMap");
  for (const type of ["select", "insert", "update", "delete", "procedure", "statement"]) {
    for (const element of findXmlElements(source, type, filePath, locator)) {
      const id = element.attributes.id ?? "";
      if (!id) continue;
      const expandedInner = expandIncludes(element.inner, fragmentMap);
      const sql = sqlText(expandedInner);
      const includes = [...element.inner.matchAll(/<include\b[^>]*\brefid\s*=\s*(["'])(.*?)\1[^>]*\/?\s*>/gi)]
        .map((match) => match[2]);
      const tables = extractSqlTables(sql, type);
      const procedureName = referencedProcedure(procedureSqlSource(expandedInner));
      const fullId = namespace ? `${namespace}.${id}` : id;
      if (type === "procedure" && !procedureName) {
        warnings.push(`unresolved SQL Server procedure target in iBATIS statement ${fullId} at ${element.evidence.file}:${element.evidence.line}`);
      }
      statements.push({
        id,
        fullId: namespace ? `${namespace}.${id}` : id,
        type,
        parameterClass: element.attributes.parameterClass ?? element.attributes.parameterMap ?? "",
        resultClass: element.attributes.resultClass ?? "",
        resultMap: element.attributes.resultMap ?? "",
        sql,
        includes,
        reads: tables.reads,
        writes: tables.writes,
        ...(procedureName ? { procedureName } : {}),
        evidence: element.evidence,
        offset: element.offset,
      });
    }
  }
  statements.sort((left, right) => left.offset - right.offset);

  return {
    namespace,
    fragments,
    statements: statements.map(({ offset: _offset, ...statement }) => statement),
    warnings,
  };
}
