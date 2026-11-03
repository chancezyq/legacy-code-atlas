import { createEvidenceLocator } from "../evidence.mjs";
import { maskedSource } from "./source-masking.mjs";
import {
  requestTarget,
  requestTargetMetadata,
  staticHttpMethod,
} from "./request-target.mjs";

// JavaScript request extraction, moved out of the JSP parser so that file
// can shrink. Behavior is unchanged: this module is the only user of the
// scanning helpers below, and the JSP parser re-exports the entry point.

function quotedJavaScriptEnd(source, start, quote) {
  let cursor = start + 1;
  let escaped = false;
  while (cursor < source.length) {
    const character = source[cursor];
    cursor += 1;
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) break;
  }
  return cursor;
}

function legacyClosingCommentAt(source, cursor) {
  if (!source.startsWith("-->", cursor)) return false;
  const lineStart = Math.max(source.lastIndexOf("\n", cursor - 1), source.lastIndexOf("\r", cursor - 1)) + 1;
  return /^[\t\v\f ]*$/u.test(source.slice(lineStart, cursor));
}

function lineCommentEnd(source, start) {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline;
}

function regexLiteralEnd(source, start) {
  let cursor = start + 1;
  let escaped = false;
  let inCharacterClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\n" || character === "\r") return start;
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      cursor += 1;
      while (/[A-Za-z]/u.test(source[cursor] ?? "")) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return start;
}

function canStartRegexLiteral(source, start) {
  let cursor = start - 1;
  while (cursor >= 0 && /\s/u.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if ((source[cursor] === "+" || source[cursor] === "-") && source[cursor - 1] === source[cursor]) {
    return false;
  }
  if (/[([{,:;=!?&|+\-*%^~<>}]/u.test(source[cursor])) return true;
  if (source[cursor] === ")") return closingControlHeaderAllowsRegex(source, cursor);
  if (!/[A-Za-z_$]/u.test(source[cursor])) return false;
  const end = cursor + 1;
  while (cursor >= 0 && /[\w$]/u.test(source[cursor])) cursor -= 1;
  return new Set([
    "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of",
    "return", "throw", "typeof", "void", "yield",
  ]).has(source.slice(cursor + 1, end));
}

function closingControlHeaderAllowsRegex(source, closingIndex) {
  let depth = 1;
  let cursor = closingIndex - 1;
  while (cursor >= 0 && depth > 0) {
    if (source[cursor] === ")") depth += 1;
    else if (source[cursor] === "(") depth -= 1;
    cursor -= 1;
  }
  if (depth !== 0) return false;
  while (cursor >= 0 && /\s/u.test(source[cursor])) cursor -= 1;
  const end = cursor + 1;
  while (cursor >= 0 && /[\w$]/u.test(source[cursor])) cursor -= 1;
  return new Set(["catch", "for", "if", "switch", "while", "with"]).has(
    source.slice(cursor + 1, end),
  );
}

function scanJavaScriptCode(source, start, ranges, stopAtClosingBrace = false) {
  let cursor = start;
  let braceDepth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      const end = quotedJavaScriptEnd(source, cursor, character);
      ranges.push([cursor, end, "string"]);
      cursor = end;
      continue;
    }
    if (character === "`") {
      cursor = scanTemplateLiteral(source, cursor, ranges);
      continue;
    }
    if (source.startsWith("//", cursor)
      || source.startsWith("<!--", cursor)
      || legacyClosingCommentAt(source, cursor)) {
      const end = lineCommentEnd(source, cursor + 2);
      ranges.push([cursor, end, "comment"]);
      cursor = end;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const closing = source.indexOf("*/", cursor + 2);
      const end = closing === -1 ? source.length : closing + 2;
      ranges.push([cursor, end, "comment"]);
      cursor = end;
      continue;
    }
    if (character === "/" && canStartRegexLiteral(source, cursor)) {
      const end = regexLiteralEnd(source, cursor);
      if (end > cursor) {
        ranges.push([cursor, end, "regex"]);
        cursor = end;
        continue;
      }
    }
    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      if (stopAtClosingBrace && braceDepth === 0) return cursor + 1;
      if (braceDepth > 0) braceDepth -= 1;
    }
    cursor += 1;
  }
  return cursor;
}

function scanTemplateLiteral(source, start, ranges) {
  let rawStart = start;
  let cursor = start + 1;
  let escaped = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === "`") {
      ranges.push([rawStart, cursor + 1, "string"]);
      return cursor + 1;
    }
    if (character === "$" && source[cursor + 1] === "{") {
      ranges.push([rawStart, cursor + 2, "string"]);
      const expressionEnd = scanJavaScriptCode(source, cursor + 2, ranges, true);
      rawStart = Math.max(cursor + 2, expressionEnd - 1);
      cursor = expressionEnd;
      continue;
    }
    cursor += 1;
  }
  ranges.push([rawStart, source.length, "string"]);
  return source.length;
}

function javaScriptNonCodeRanges(source) {
  const ranges = [];
  scanJavaScriptCode(source, 0, ranges);
  return ranges.sort(([left], [right]) => left - right);
}

function offsetInRanges(ranges, offset) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle][1] <= offset) low = middle + 1;
    else high = middle;
  }
  return low < ranges.length && ranges[low][0] <= offset;
}

function staticStringLiteral(source) {
  const match = source.match(/^(["'])([^\\\r\n]*?)\1/su);
  if (!match) return { known: false, partial: false, value: "" };
  const remainder = source.slice(match[0].length).trim();
  return { known: !remainder, partial: Boolean(remainder), value: match[2] };
}

function objectEntry(segment) {
  const commentRanges = javaScriptNonCodeRanges(segment)
    .filter((range) => range[2] === "comment");
  const source = maskedSource(segment, commentRanges).trim();
  if (!source) return null;
  if (source.startsWith("...") || source.startsWith("[")) return { unknownAll: true };

  const keyMatch = source.match(/^(?:([A-Za-z_$][\w$]*)|(["'])([A-Za-z_$][\w$]*)\2)/u);
  if (!keyMatch) return { unknownAll: true };
  const key = keyMatch[1] ?? keyMatch[3];
  const remainder = source.slice(keyMatch[0].length).trimStart();
  if (!remainder.startsWith(":")) return { key, known: false, value: "" };
  return { key, ...staticStringLiteral(remainder.slice(1).trim()) };
}

function boundedObject(source, start, maxCharacters = 4_096) {
  if (source[start] !== "{") return null;
  const limit = Math.min(source.length, start + maxCharacters);
  const ranges = javaScriptNonCodeRanges(source.slice(start, limit))
    .map(([rangeStart, rangeEnd, kind]) => [rangeStart + start, rangeEnd + start, kind]);
  const closingByOpening = new Map([["{", "}"], ["[", "]"], ["(", ")"]]);
  const stack = ["}"];
  const segments = [];
  let segmentStart = start + 1;
  let rangeIndex = 0;
  let cursor = start + 1;
  while (cursor < limit) {
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= cursor) rangeIndex += 1;
    if (rangeIndex < ranges.length && ranges[rangeIndex][0] === cursor) {
      cursor = ranges[rangeIndex][1];
      continue;
    }
    const character = source[cursor];
    const closing = closingByOpening.get(character);
    if (closing) {
      stack.push(closing);
      cursor += 1;
      continue;
    }
    if (["}", "]", ")"].includes(character)) {
      if (stack.at(-1) !== character) return null;
      stack.pop();
      if (stack.length === 0) {
        segments.push(source.slice(segmentStart, cursor));
        return {
          end: cursor + 1,
          entries: segments.map(objectEntry).filter(Boolean),
        };
      }
      cursor += 1;
      continue;
    }
    if (character === "," && stack.length === 1) {
      segments.push(source.slice(segmentStart, cursor));
      segmentStart = cursor + 1;
    }
    cursor += 1;
  }
  return null;
}

function objectPropertyState(entries, key) {
  let state = { kind: "absent", value: "" };
  for (const entry of entries) {
    if (entry.unknownAll) {
      state = { kind: "unknown", value: "" };
    } else if (entry.key === key) {
      state = entry.known
        ? { kind: "known", value: entry.value }
        : entry.partial
          ? { kind: "partial", value: entry.value }
          : { kind: "unknown", value: "" };
    }
  }
  return state;
}

function fetchMethodAfterUrl(source, start) {
  const skipTrivia = (offset) => {
    let cursor = offset;
    while (cursor < source.length) {
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      if (source.startsWith("/*", cursor)) {
        const closing = source.indexOf("*/", cursor + 2);
        if (closing === -1) return source.length;
        cursor = closing + 2;
        continue;
      }
      if (source.startsWith("//", cursor)) {
        cursor = lineCommentEnd(source, cursor + 2);
        continue;
      }
      return cursor;
    }
    return cursor;
  };
  let cursor = skipTrivia(start);
  if (source[cursor] !== ",") return "GET";
  cursor = skipTrivia(cursor + 1);
  const options = boundedObject(source, cursor);
  if (options === null) return "";
  const method = objectPropertyState(options.entries, "method");
  if (method.kind === "absent") return "GET";
  return method.kind === "known" ? staticHttpMethod(method.value, "") : "";
}

function ajaxMethod(entries) {
  const method = objectPropertyState(entries, "method");
  if (method.kind === "known" && method.value) return staticHttpMethod(method.value, "");
  if (method.kind === "unknown") return "";
  const type = objectPropertyState(entries, "type");
  if (type.kind === "known") return staticHttpMethod(type.value, "");
  return type.kind === "absent" ? "GET" : "";
}

export function extractJavaScriptRequests(
  content,
  filePath,
  basePath = "",
  locator = createEvidenceLocator(content, filePath),
  scanContent = content,
) {
  locator.assertSource(content, filePath);
  const requests = [];
  const nonCodeRanges = javaScriptNonCodeRanges(scanContent);

  for (const match of scanContent.matchAll(/\bfetch\s*\(\s*(["'])(.*?)\1/gis)) {
    if (offsetInRanges(nonCodeRanges, match.index)) continue;
    const target = requestTarget(match[2], basePath);
    requests.push({
      kind: "fetch",
      url: target.url,
      method: fetchMethodAfterUrl(scanContent, match.index + match[0].length),
      ...requestTargetMetadata(target),
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  for (const match of scanContent.matchAll(/\.open\s*\(\s*(["'])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(["'])(.*?)\3/gis)) {
    if (offsetInRanges(nonCodeRanges, match.index)) continue;
    const target = requestTarget(match[4], basePath);
    requests.push({
      kind: "xhr",
      url: target.url,
      method: match[2].toUpperCase(),
      ...requestTargetMetadata(target),
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  for (const match of scanContent.matchAll(/\$\s*\.\s*ajax\s*\(\s*\{/gi)) {
    if (offsetInRanges(nonCodeRanges, match.index)) continue;
    const objectStart = match.index + match[0].lastIndexOf("{");
    const options = boundedObject(scanContent, objectStart);
    if (options === null) continue;
    const url = objectPropertyState(options.entries, "url");
    if (url.kind !== "known" && url.kind !== "partial") continue;
    const target = requestTarget(url.value, basePath);
    requests.push({
      kind: "ajax",
      url: target.url,
      method: ajaxMethod(options.entries),
      ...requestTargetMetadata(target),
      evidence: locator.at(match.index, options.end - match.index),
      offset: match.index,
    });
  }

  return requests
    .filter((request) => request.url || Object.hasOwn(request, "relativeUrl"))
    .sort((left, right) => left.offset - right.offset)
    .map(({ offset: _offset, ...request }) => request);
}
