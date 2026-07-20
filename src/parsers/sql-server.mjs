import { createEvidenceLocator } from "../evidence.mjs";
import { extractSqlTables, normalizeTableName } from "./ibatis.mjs";

const IDENTIFIER = String.raw`(?:\[[^\]]+\]|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:\[[^\]]+\]|[A-Za-z_][\w$#]*))*`;

function maskSql(source) {
  let output = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
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

function splitParameters(header) {
  return header
    .split(",")
    .map((parameter) => parameter.replace(/\s+/g, " ").trim())
    .filter((parameter) => parameter.startsWith("@"));
}

function combinedTables(sql) {
  const reads = new Set();
  const writes = new Set();
  for (const type of ["select", "update", "insert", "delete"]) {
    const tables = extractSqlTables(sql, type);
    for (const table of tables.reads) reads.add(table);
    for (const table of tables.writes) writes.add(table);
  }
  for (const table of writes) reads.delete(table);
  return {
    reads: [...reads].sort((left, right) => left.localeCompare(right, "en")),
    writes: [...writes].sort((left, right) => left.localeCompare(right, "en")),
  };
}

export function parseSqlServer(content, filePath) {
  const masked = maskSql(content);
  const locator = createEvidenceLocator(content, filePath);
  const pattern = new RegExp(`\\b(?:CREATE\\s+(?:OR\\s+ALTER\\s+)?|ALTER\\s+)PROC(?:EDURE)?\\s+(${IDENTIFIER})`, "gi");
  const matches = [...masked.matchAll(pattern)];
  const procedures = [];
  const warnings = [];

  for (const [index, match] of matches.entries()) {
    const nextDefinition = matches[index + 1]?.index ?? content.length;
    const batchEndMatch = masked.slice(match.index, nextDefinition).match(/^\s*GO\s*$/im);
    const batchEnd = batchEndMatch ? match.index + batchEndMatch.index : nextDefinition;
    const asMatch = masked.slice(match.index, batchEnd).match(/\bAS\b/i);
    const asOffset = asMatch ? match.index + asMatch.index : match.index + match[0].length;
    const bodyOffset = asOffset + (asMatch?.[0].length ?? 0);
    const body = content.slice(bodyOffset, batchEnd);
    const maskedBody = maskSql(body);
    const dynamicExec = maskedBody.match(/\bEXEC(?:UTE)?\s*(?:\(|@(?![A-Za-z_][\w$]*\s*=))/i);
    if (dynamicExec) {
      warnings.push(`dynamic SQL Server procedure target in ${filePath} at line ${locator.at(bodyOffset + dynamicExec.index, dynamicExec[0].length).line} (EXEC)`);
    }
    const tables = combinedTables(body);
    const calls = [...maskedBody.matchAll(new RegExp(`\\bEXEC(?:UTE)?\\s+(?!AS\\b)(?:@[A-Za-z_][\\w$]*\\s*=\\s*)?(${IDENTIFIER})`, "gi"))]
      .map((call) => normalizeTableName(call[1]));
    const fullName = normalizeTableName(match[1]);
    procedures.push({
      name: fullName.split(".").at(-1),
      fullName,
      parameters: splitParameters(content.slice(match.index + match[0].length, asOffset)),
      body: body.replace(/\s+/g, " ").trim(),
      reads: tables.reads,
      writes: tables.writes,
      calls: [...new Set(calls)].sort((left, right) => left.localeCompare(right, "en")),
      evidence: locator.at(match.index, match[0].length),
    });
  }

  return { procedures, warnings };
}
