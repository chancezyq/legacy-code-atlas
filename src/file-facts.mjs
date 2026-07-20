import path from "node:path";

import { parseIbatisSqlMap } from "./parsers/ibatis.mjs";
import { parseJava } from "./parsers/java.mjs";
import { extractJavaScriptRequests, parseJsp } from "./parsers/jsp.mjs";
import { parseSqlServer } from "./parsers/sql-server.mjs";
import {
  parseSpringConfig,
  parseStruts2Config,
  parseStrutsConfig,
  parseTilesDefinitions,
  parseWebXml,
  createWebConfigContext,
} from "./parsers/web-config.mjs";

export const FACT_SCHEMA = "1.0.0";

export const PARSER_VERSIONS = Object.freeze({
  java: "1.4.2",
  jsp: "1.2.0",
  javascript: "1.0.0",
  xml: "1.3.4",
  sql: "1.0.0",
  metadata: "1.0.0",
});

const PARSED_LANGUAGES = new Set(["java", "jsp", "javascript", "xml", "sql"]);
const METADATA_LANGUAGES = new Set(["html", "properties", "markdown", "text"]);

function relativePathFor(file) {
  const raw = String(file?.relativePath ?? file?.path ?? "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) {
    throw new TypeError(`file path must be a relative path: ${raw}`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`file path must be a relative path: ${raw}`);
  }
  return normalized;
}

function recordBase(file, parserKind) {
  let size;
  try {
    size = Number(file?.size ?? 0);
  } catch {
    throw new TypeError("file size must be a finite non-negative number");
  }
  if (!Number.isFinite(size) || size < 0) {
    throw new TypeError("file size must be a finite non-negative number");
  }
  return {
    factSchema: FACT_SCHEMA,
    relativePath: relativePathFor(file),
    language: String(file?.language ?? ""),
    category: String(file?.category ?? ""),
    size: Object.is(size, -0) ? 0 : size,
    parserKind,
    parserVersion: PARSER_VERSIONS[parserKind],
  };
}

function xmlRootTagName(content) {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, " ");
  return withoutComments.match(/<(?![!?/])([A-Za-z_][\w:.-]*)(?=\s|\/?>)/)?.[1]?.toLowerCase() ?? "";
}

function parseXml(content, relativePath) {
  const rootTag = xmlRootTagName(content);
  const ibatis = rootTag === "sqlmap" ? parseIbatisSqlMap(content, relativePath) : null;
  let webContext;
  const getWebContext = () => (webContext ??= createWebConfigContext(content, relativePath));
  const web = /<web-app(?=\s|>)/i.test(content) ? parseWebXml(content, relativePath, getWebContext()) : null;
  const struts = /<struts-config(?=\s|>)/i.test(content) ? parseStrutsConfig(content, relativePath, getWebContext()) : null;
  const struts2 = /<(?:struts|xwork)(?=\s|>)/i.test(content) ? parseStruts2Config(content, relativePath, getWebContext()) : null;
  const tiles = /<tiles-definitions(?=\s|>)/i.test(content) ? parseTilesDefinitions(content, relativePath, getWebContext()) : null;
  const spring = /<beans(?=\s|>)/i.test(content) ? parseSpringConfig(content, relativePath, getWebContext()) : null;
  return { ibatis, web, struts, struts2, tiles, spring };
}

const DEFAULT_PARSERS = Object.freeze({
  java: parseJava,
  jsp: parseJsp,
  javascript(content, relativePath) {
    return { requests: extractJavaScriptRequests(content, relativePath) };
  },
  xml: parseXml,
  sql: parseSqlServer,
});

function parserWarnings(parserKind, facts) {
  if (parserKind !== "xml") return facts.warnings ?? [];
  return [facts.ibatis, facts.web, facts.struts, facts.struts2, facts.tiles, facts.spring]
    .flatMap((parsed) => parsed?.warnings ?? []);
}

function absolutePathVariants(value) {
  const raw = String(value ?? "");
  if (!path.posix.isAbsolute(raw) && !path.win32.isAbsolute(raw)) return [];
  return [...new Set([raw, raw.replaceAll("\\", "/"), raw.replaceAll("/", "\\")])];
}

function redactAbsolutePaths(value, knownPaths = []) {
  let message = String(value);
  for (const knownPath of knownPaths.flatMap(absolutePathVariants)) {
    message = message.split(knownPath).join("<absolute-path>");
  }
  const preservedUrls = [];
  message = message.replace(
    /\b(?:https?|ftp):\/\/[^\s"'`<>()]+/gi,
    (url) => {
      const marker = `\u0001${preservedUrls.length}\u0002`;
      preservedUrls.push(url);
      return marker;
    },
  );
  message = message.replace(
    /\bfile:\/\/\/(?:[A-Za-z]:[\\/])?[^\s"'`<>()\[\]{},;:]+/gi,
    "<absolute-path>",
  );
  message = message.replace(
    /\bfile:\/\/(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>()\[\]{},;:]+/gi,
    "<absolute-path>",
  );
  message = message.replace(
    /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\\|\/)[^"'`\r\n]*)\1/g,
    "$1<absolute-path>$1",
  );
  message = message.replace(
    /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\|\\|\/)[^\s"'`<>()\[\]{},;:]+/g,
    "<absolute-path>",
  );
  return message.replace(/\u0001(\d+)\u0002/g, (_, index) => preservedUrls[Number(index)]);
}

function readErrorProperty(error, property) {
  try {
    return { ok: true, value: error?.[property] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function stringOrFallback(value, fallback) {
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function serializableError(error, knownPaths = []) {
  const name = readErrorProperty(error, "name");
  const message = readErrorProperty(error, "message");
  const code = readErrorProperty(error, "code");
  const messageText = !message.ok
    ? "parser failed"
    : typeof message.value === "string"
      ? message.value
      : stringOrFallback(error, "parser failed");
  const result = {
    name: redactAbsolutePaths(name.ok && typeof name.value === "string" ? name.value : "Error", knownPaths),
    message: redactAbsolutePaths(messageText, knownPaths),
  };
  if (code.ok && ["string", "number"].includes(typeof code.value)) {
    result.code = redactAbsolutePaths(String(code.value), knownPaths);
  }
  return result;
}

function assertJsonSafeFacts(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return;
    throw new TypeError("parser facts must be JSON-safe plain data");
  }
  if (typeof value !== "object" || Buffer.isBuffer(value)) {
    throw new TypeError("parser facts must be JSON-safe plain data");
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("parser facts must be JSON-safe plain data");
  }
  if (ancestors.has(value)) throw new TypeError("parser facts must be JSON-safe plain data");
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const key of keys) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
        throw new TypeError("parser facts must be JSON-safe plain data");
      }
    }
    if (keys.length !== value.length) throw new TypeError("parser facts must be JSON-safe plain data");
  }
  for (const nested of Object.values(value)) assertJsonSafeFacts(nested, ancestors);
  ancestors.delete(value);
}

export function parserKindFor(file) {
  const language = String(file?.language ?? "").toLowerCase();
  if (PARSED_LANGUAGES.has(language)) return language;
  if (METADATA_LANGUAGES.has(language)) return "metadata";
  return null;
}

export function metadataFact(file) {
  const record = {
    ...recordBase(file, "metadata"),
    status: "metadata",
    facts: {},
    warnings: [],
    diagnostics: [],
  };
  assertJsonSafeFacts(record);
  return record;
}

export function parseFileBuffer(file, buffer, options = {}) {
  const parserKind = parserKindFor(file);
  if (parserKind === "metadata") return metadataFact(file);
  if (!parserKind) throw new TypeError(`no parser for source language: ${file?.language ?? ""}`);
  if (!Buffer.isBuffer(buffer)) throw new TypeError("parseFileBuffer requires a Buffer");

  const base = recordBase(file, parserKind);
  if (buffer.includes(0)) {
    return {
      ...base,
      status: "binary",
      facts: null,
      warnings: [],
      diagnostics: [{ code: "binary-file", relativePath: base.relativePath }],
    };
  }

  const content = buffer.toString("utf8");
  const parser = options.parsers?.[parserKind] ?? DEFAULT_PARSERS[parserKind];
  try {
    const facts = parser(content, base.relativePath);
    assertJsonSafeFacts(facts);
    return {
      ...base,
      status: "parsed",
      facts,
      warnings: parserWarnings(parserKind, facts),
      diagnostics: [],
    };
  } catch (error) {
    let absolutePath;
    try {
      absolutePath = file?.absolutePath;
    } catch {
      absolutePath = undefined;
    }
    const serialized = serializableError(error, typeof absolutePath === "string" ? [absolutePath] : []);
    return {
      ...base,
      status: "error",
      facts: null,
      warnings: [],
      diagnostics: [{
        code: "parser-error",
        relativePath: base.relativePath,
        parserKind,
        message: serialized.message,
      }],
      error: serialized,
    };
  }
}
