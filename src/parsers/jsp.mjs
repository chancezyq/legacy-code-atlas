import { createEvidenceLocator } from "../evidence.mjs";

const STATIC_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const JAVA_SCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/jscript",
  "text/livescript",
]);

function attributeEntriesFrom(tag) {
  const entries = [];
  let cursor = 1;
  if (tag[cursor] === "/") cursor += 1;
  while (cursor < tag.length && /\s/u.test(tag[cursor])) cursor += 1;
  while (cursor < tag.length && !/[\s>]/u.test(tag[cursor])) cursor += 1;

  while (cursor < tag.length) {
    while (cursor < tag.length && /\s/u.test(tag[cursor])) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === ">" || tag[cursor] === "%") break;
    if (tag[cursor] === "/") {
      cursor += 1;
      continue;
    }
    const index = cursor;
    while (cursor < tag.length && !/[\s=/>%]/u.test(tag[cursor])) cursor += 1;
    if (cursor === index) {
      cursor += 1;
      continue;
    }
    const name = tag.slice(index, cursor).toLowerCase();
    while (cursor < tag.length && /\s/u.test(tag[cursor])) cursor += 1;
    if (tag[cursor] !== "=") {
      entries.push({ name, value: "", index });
      continue;
    }
    cursor += 1;
    while (cursor < tag.length && /\s/u.test(tag[cursor])) cursor += 1;
    const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor] : "";
    if (quote) {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
      entries.push({ name, value: tag.slice(valueStart, cursor), index });
      if (tag[cursor] === quote) cursor += 1;
      continue;
    }
    const valueStart = cursor;
    while (cursor < tag.length && !/[\s>]/u.test(tag[cursor])) {
      if (tag[cursor] === "/" && /^\s*>/u.test(tag.slice(cursor + 1))) break;
      cursor += 1;
    }
    entries.push({ name, value: tag.slice(valueStart, cursor), index });
  }
  return entries;
}

function attributesFrom(tag) {
  const attributes = {};
  for (const entry of attributeEntriesFrom(tag)) attributes[entry.name] = entry.value;
  return attributes;
}

function staticHttpMethod(value, fallback) {
  if (value === undefined) return fallback;
  const method = String(value).trim().toUpperCase();
  return STATIC_HTTP_METHODS.has(method) ? method : "";
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["quot", '"'],
  ]);
  return String(value ?? "").replace(
    /&(?:#([0-9]+)|#x([0-9a-f]+)|([a-z]+));/giu,
    (match, decimal, hexadecimal, entityName) => {
      if (entityName) return named.get(entityName.toLowerCase()) ?? match;
      const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
      if (!Number.isInteger(codePoint)
        || codePoint <= 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(codePoint);
    },
  );
}

function isJavaScriptScript(attributes) {
  if (!Object.hasOwn(attributes, "type")) return true;
  const type = attributes.type.trim().toLowerCase().split(";", 1)[0].trim();
  return !type || type === "module" || JAVA_SCRIPT_TYPES.has(type);
}

export function webPathForFile(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").replace(/^\.\//, "");
  for (const marker of ["src/main/webapp/", "WebRoot/", "WebContent/", "web/"]) {
    const index = normalized.indexOf(marker);
    if (index !== -1) return `/${normalized.slice(index + marker.length)}`.replace(/\/{2,}/g, "/");
  }
  return `/${normalized}`.replace(/\/{2,}/g, "/");
}

function queryParametersFrom(query) {
  const parameters = {};
  for (const [name, value] of new URLSearchParams(query)) {
    if (!name || /\$\{|%\{|<%/u.test(name)) continue;
    const normalizedValue = /\$\{|%\{|<%/u.test(value) ? "" : value;
    if (!Object.hasOwn(parameters, name)) parameters[name] = normalizedValue;
    else if (parameters[name] !== normalizedValue) parameters[name] = "";
  }
  return parameters;
}

function requestTarget(rawUrl, basePath = "") {
  const emptyTarget = () => ({ url: "", parameters: {}, queryParameterNames: [] });
  if (rawUrl === undefined || rawUrl === null) return emptyTarget();
  const cUrl = rawUrl.match(/<c:url\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1[^>]*\/?\s*>/is);
  let value = cUrl ? cUrl[2] : rawUrl;
  value = value
    .replace(/\$\{\s*pageContext\.request\.contextPath\s*}/g, "")
    .replace(/\$\{\s*(?:ctx|contextPath)\s*}/g, "")
    .trim();
  if (value.startsWith("#")
    || value.startsWith("//")
    || value.startsWith("\\\\")
    || URL_SCHEME.test(value)) return emptyTarget();
  const withoutFragment = value.split("#", 1)[0];
  const queryOffset = withoutFragment.indexOf("?");
  const relative = queryOffset === -1 ? withoutFragment : withoutFragment.slice(0, queryOffset);
  const query = queryOffset === -1 ? "" : withoutFragment.slice(queryOffset + 1);
  const parameters = queryParametersFrom(query);
  const queryParameterNames = Object.keys(parameters);
  if (/\$\{|%\{|<%/u.test(relative)) return emptyTarget();
  const isRelative = !relative.startsWith("/");
  if (!basePath && isRelative) {
    return { url: relative, parameters, queryParameterNames, relativeUrl: withoutFragment };
  }
  try {
    const base = `http://legacy.local${String(basePath || "/").startsWith("/") ? basePath || "/" : `/${basePath}`}`;
    return {
      url: new URL(relative, base).pathname.replace(/\/{2,}/g, "/"),
      parameters,
      queryParameterNames,
      ...(isRelative ? { relativeUrl: withoutFragment } : {}),
    };
  } catch {
    return emptyTarget();
  }
}

export function normalizeRequestUrl(rawUrl, basePath = "") {
  return requestTarget(rawUrl, basePath).url;
}

function requestParameters(target) {
  return Object.keys(target.parameters).length > 0 ? { parameters: target.parameters } : {};
}

function requestTargetMetadata(target) {
  return {
    ...requestParameters(target),
    ...(target.queryParameterNames.length > 0 ? { queryParameterNames: target.queryParameterNames } : {}),
    ...(Object.hasOwn(target, "relativeUrl") ? { relativeUrl: target.relativeUrl } : {}),
  };
}

function markupRequestTarget(rawUrl, basePath = "") {
  return requestTarget(decodeHtmlEntities(rawUrl), basePath);
}

function mergeRequestParameters(...sources) {
  const parameters = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (!Object.hasOwn(parameters, name)) parameters[name] = value;
      else if (parameters[name] !== value) parameters[name] = "";
    }
  }
  return parameters;
}

function requestEvidence(locator, match, attributeName, source = match[0]) {
  let localOffset = 0;
  if (attributeName) {
    const wanted = attributeName.toLowerCase();
    for (const attribute of attributeEntriesFrom(source)) {
      if (attribute.name !== wanted) continue;
      localOffset = attribute.index;
      break;
    }
  }
  return locator.at(match.index + localOffset, source.length);
}

function sourceForMatch(content, match) {
  return match.source ?? content.slice(match.index, match.end ?? (match.index + match[0].length));
}

function tagEndOffset(content, start) {
  let quote = "";
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return { end: index + 1, closed: true };
  }
  return { end: content.length, closed: false };
}

function tagAt(content, start, end) {
  const match = content.slice(start, end).match(/^<\s*(\/?)\s*([A-Za-z][\w:-]*)(?=[\s/>])/u);
  if (!match) return null;
  return {
    closing: match[1] === "/",
    name: match[2].toLowerCase(),
    selfClosing: /\/\s*>$/u.test(content.slice(start, end)),
  };
}

function plausibleTagStart(content, start) {
  let cursor = start + 1;
  while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
  if (content[cursor] === "/") {
    cursor += 1;
    while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
  }
  if (!/[A-Za-z]/u.test(content[cursor] ?? "")) return false;
  cursor += 1;
  while (/[\w:-]/u.test(content[cursor] ?? "")) cursor += 1;
  return /[\s/>]/u.test(content[cursor] ?? "");
}

function rawClosingTag(content, tagName, start) {
  const pattern = new RegExp(`</${tagName}(?=[\\s>])`, "gi");
  pattern.lastIndex = start;
  const match = pattern.exec(content);
  if (!match) return null;
  const { end } = tagEndOffset(content, match.index);
  return { start: match.index, end };
}

function appendCommentRanges(content, start, end, ranges) {
  let cursor = start;
  while (cursor < end) {
    const jspStart = content.indexOf("<%", cursor);
    const htmlStart = content.indexOf("<!--", cursor);
    const candidates = [jspStart, htmlStart].filter((index) => index !== -1 && index < end);
    if (candidates.length === 0) break;
    const opening = Math.min(...candidates);
    const jspComment = content.startsWith("<%--", opening);
    const terminator = opening === jspStart ? (jspComment ? "--%>" : "%>") : "-->";
    const closing = content.indexOf(terminator, opening + (jspComment ? 4 : terminator === "-->" ? 4 : 2));
    const hiddenEnd = closing === -1 || closing >= end ? end : closing + terminator.length;
    ranges.push([opening, hiddenEnd]);
    cursor = hiddenEnd;
  }
}

function maskedSource(content, ranges) {
  if (ranges.length === 0) return content;
  const ordered = ranges
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  const merged = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1]) {
      merged.push([...range]);
      continue;
    }
    previous[1] = Math.max(previous[1], range[1]);
  }
  const chunks = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    chunks.push(content.slice(cursor, start), blankRegion(content.slice(start, end)));
    cursor = end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

function sourceWithinRanges(content, ranges) {
  const ordered = ranges
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  const chunks = [];
  let cursor = 0;
  for (const [start, end] of ordered) {
    chunks.push(blankRegion(content.slice(cursor, start)), content.slice(start, end));
    cursor = end;
  }
  chunks.push(blankRegion(content.slice(cursor)));
  return chunks.join("");
}

function jspScanSources(content) {
  const structureRanges = [];
  const javaScriptRanges = [];
  const executableJavaScriptRanges = [];
  const tags = [];
  const includeDirectives = [];
  const templateStack = [];
  let cursor = 0;

  while (cursor < content.length) {
    const opening = content.indexOf("<", cursor);
    if (opening === -1) break;

    if (content.startsWith("<%--", opening)) {
      const closing = content.indexOf("--%>", opening + 4);
      const end = closing === -1 ? content.length : closing + 4;
      structureRanges.push([opening, end]);
      javaScriptRanges.push([opening, end]);
      cursor = end;
      continue;
    }
    if (content.startsWith("<!--", opening)) {
      const closing = content.indexOf("-->", opening + 4);
      const end = closing === -1 ? content.length : closing + 3;
      structureRanges.push([opening, end]);
      javaScriptRanges.push([opening, end]);
      cursor = end;
      continue;
    }
    if (content.startsWith("<%", opening)) {
      const closing = content.indexOf("%>", opening + 2);
      const closed = closing !== -1;
      const end = closed ? closing + 2 : content.length;
      const source = content.slice(opening, end);
      if (closed && /^<%@\s*include(?=[\s%])/iu.test(source)) {
        const file = attributesFrom(source).file;
        if (file && !/\$\{|%\{|<%/u.test(file)) {
          includeDirectives.push({ index: opening, end, source, file });
        }
      }
      structureRanges.push([opening, end]);
      javaScriptRanges.push([opening, end]);
      cursor = end;
      continue;
    }

    if (!plausibleTagStart(content, opening)) {
      cursor = opening + 1;
      continue;
    }
    const tagEnd = tagEndOffset(content, opening);
    const end = tagEnd.end;
    if (!tagEnd.closed) {
      const incompleteTag = tagAt(content, opening, end);
      if (incompleteTag) {
        structureRanges.push([opening, end]);
        javaScriptRanges.push([opening, end]);
        cursor = end;
      } else {
        cursor = opening + 1;
      }
      continue;
    }
    const tagSource = content.slice(opening + 1, end);
    if (tagSource.includes("<%") || tagSource.includes("<!--")) {
      const embeddedRanges = [];
      appendCommentRanges(content, opening + 1, end, embeddedRanges);
      structureRanges.push(...embeddedRanges);
      javaScriptRanges.push(...embeddedRanges);
    }
    const tag = tagAt(content, opening, end);
    if (!tag) {
      cursor = end;
      continue;
    }

    const hiddenByTemplate = templateStack.length > 0;
    if (!hiddenByTemplate && tag.name !== "template") {
      tags.push({ ...tag, index: opening, end, source: content.slice(opening, end) });
    }

    if (tag.name === "template") {
      if (tag.closing) {
        const active = templateStack.pop();
        if (active && templateStack.length === 0) {
          structureRanges.push([active.bodyStart, opening]);
          javaScriptRanges.push([active.bodyStart, opening]);
        }
      } else if (!tag.selfClosing) {
        templateStack.push({ bodyStart: end });
      }
      cursor = end;
      continue;
    }

    if (!tag.closing && !tag.selfClosing && ["script", "style", "textarea"].includes(tag.name)) {
      const closing = rawClosingTag(content, tag.name, end);
      const bodyEnd = closing?.start ?? content.length;
      structureRanges.push([end, bodyEnd]);
      const attributes = attributesFrom(content.slice(opening, end));
      if (tag.name === "script" && (!isJavaScriptScript(attributes) || Object.hasOwn(attributes, "src"))) {
        javaScriptRanges.push([end, bodyEnd]);
      } else if (tag.name === "script") {
        executableJavaScriptRanges.push([end, bodyEnd]);
        let scriptlet = content.indexOf("<%", end);
        while (scriptlet !== -1 && scriptlet < bodyEnd) {
          const closingScriptlet = content.indexOf("%>", scriptlet + 2);
          const scriptletEnd = closingScriptlet === -1 || closingScriptlet >= bodyEnd
            ? bodyEnd
            : closingScriptlet + 2;
          javaScriptRanges.push([scriptlet, scriptletEnd]);
          scriptlet = content.indexOf("<%", scriptletEnd);
        }
      }
      else javaScriptRanges.push([end, bodyEnd]);
      cursor = closing?.end ?? content.length;
      continue;
    }

    cursor = end;
  }

  if (templateStack.length > 0) {
    const bodyStart = templateStack[0].bodyStart;
    structureRanges.push([bodyStart, content.length]);
    javaScriptRanges.push([bodyStart, content.length]);
  }

  return {
    structure: maskedSource(content, structureRanges),
    javaScript: maskedSource(sourceWithinRanges(content, executableJavaScriptRanges), javaScriptRanges),
    tags,
    includeDirectives,
  };
}

const FORM_TAG_NAMES = new Set(["form", "html:form", "s:form", "form:form"]);

function formBodyRanges(tags) {
  const ranges = new Map();
  const formTags = tags.filter((tag) => FORM_TAG_NAMES.has(tag.name));
  for (let index = 0; index < formTags.length; index += 1) {
    const tag = formTags[index];
    if (tag.closing) continue;
    if (tag.selfClosing) {
      ranges.set(tag.index, { start: tag.end, end: tag.end });
      continue;
    }
    const boundary = formTags[index + 1];
    ranges.set(
      tag.index,
      boundary?.closing && boundary.name === tag.name
        ? { start: tag.end, end: boundary.index }
        : null,
    );
  }
  return ranges;
}

function strutsTaglibUrl(attributes, extension) {
  const action = (attributes.action ?? "").trim();
  if (!action) return "";
  if (URL_SCHEME.test(action) || /\$\{|%\{|<%/.test(action)) return "";
  if (extension === ".do") {
    const rooted = action.startsWith("/") || action.startsWith("${") || action.startsWith("<c:url")
      ? action
      : `/${action}`;
    const normalized = normalizeRequestUrl(rooted);
    return normalized ? `${normalized.replace(/\.do$/i, "")}.do` : "";
  }
  const namespace = (attributes.namespace ?? "").trim();
  if (/\$\{|%\{|<%/.test(namespace)) return "";
  const prefix = namespace && namespace !== "/" ? `/${namespace.replace(/^\/+|\/+$/g, "")}` : "";
  const normalizedAction = action.replace(/^\/+/, "");
  return `${prefix}/${normalizedAction}${normalizedAction.toLowerCase().endsWith(extension) ? "" : extension}`
    .replace(/\/{2,}/g, "/");
}

function extractTaglibRequests(tags, formRanges, content, locator, pageWebPath) {
  const requests = [];
  const requestTags = new Set(["html:form", "html:link", "html:rewrite", "s:form", "s:url", "s:a", "form:form"]);
  for (const match of tags) {
    if (match.closing || !requestTags.has(match.name)) continue;
    const tag = match.name;
    const source = sourceForMatch(content, match);
    const attributes = attributesFrom(source);
    const isStruts1 = tag.startsWith("html:");
    const isSpring = tag === "form:form";
    const isForm = tag.endsWith(":form");
    const isUrl = tag === "s:url";
    const isLink = tag.endsWith(":link") || tag === "s:a" || tag === "html:rewrite" || isUrl;
    const staticValue = (isSpring ? attributes.action : undefined)
      ?? attributes.page
      ?? attributes.href
      ?? (tag === "html:rewrite" || (isUrl && !attributes.action) ? attributes.value : undefined);
    const rawUrl = staticValue !== undefined
      ? staticValue
      : isStruts1
        ? strutsTaglibUrl(attributes, ".do")
        : strutsTaglibUrl(attributes, ".action");
    if (!rawUrl) continue;
    const target = markupRequestTarget(rawUrl, pageWebPath);
    if (!target.url || (!isForm && !isLink)) continue;
    requests.push({
      kind: isForm ? "form" : "link",
      url: target.url,
      method: isForm ? staticHttpMethod(attributes.method, "POST") : "GET",
      ...requestTargetMetadata(target),
      evidence: requestEvidence(
        locator,
        match,
        attributes.action ? "action" : attributes.page ? "page" : attributes.value ? "value" : "href",
        source,
      ),
      offset: match.index,
      ...(isForm ? {
        formId: attributes.id,
        formRange: formRanges.get(match.index) ?? null,
      } : {}),
    });
  }
  return requests;
}

function lowerBoundByOffset(entries, wanted) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle].offset < wanted) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fieldsForForm(formRange, formId, unownedFields, fieldsByOwner, formIdCounts) {
  const selected = [];
  if (formRange !== null) {
    const start = lowerBoundByOffset(unownedFields, formRange.start);
    const end = lowerBoundByOffset(unownedFields, formRange.end);
    selected.push(...unownedFields.slice(start, end));
  }
  if (formId && formIdCounts.get(formId) === 1) {
    selected.push(...(fieldsByOwner.get(formId) ?? []));
  }
  selected.sort((left, right) => left.offset - right.offset);
  return selected;
}

function parametersForForm(formRange, formId, unownedFields, fieldsByOwner, formIdCounts) {
  const selected = fieldsForForm(formRange, formId, unownedFields, fieldsByOwner, formIdCounts);
  const parameters = {};
  const choices = new Map();
  for (const field of selected) {
    if (!field.submittable) continue;
    if (!field.requestChoice) {
      parameters[field.name] = field.requestValue;
      continue;
    }
    const values = choices.get(field.name) ?? new Set();
    if (field.requestValue) values.add(field.requestValue);
    choices.set(field.name, values);
    if (!Object.hasOwn(parameters, field.name)) parameters[field.name] = "";
  }
  for (const [name, values] of choices) {
    parameters[name] = values.size === 1 ? values.values().next().value : "";
  }
  return parameters;
}

function countFormIds(tags, content) {
  const counts = new Map();
  for (const match of tags) {
    if (match.closing || !FORM_TAG_NAMES.has(match.name)) continue;
    const id = attributesFrom(sourceForMatch(content, match)).id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

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

function decodeVisibleText(value) {
  return value
    .replace(/\$\{[^}]*}/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function blankRegion(value) {
  return value.replace(/[^\n\r]/g, " ");
}

function extractVisibleTextEntries(masked, locator) {
  const entries = [];
  for (const match of masked.matchAll(/>([^<]+)</g)) {
    const text = decodeVisibleText(match[1]);
    if (!text) continue;
    const leadingWhitespace = match[1].search(/\S/);
    const offset = match.index + 1 + Math.max(0, leadingWhitespace);
    entries.push({ text, evidence: locator.at(offset, match[1].length) });
  }
  return entries;
}

function isChoiceField(tagName, attributes) {
  const type = (attributes.type ?? "").trim().toLowerCase();
  return (tagName === "input" && (type === "checkbox" || type === "radio"))
    || /:(?:checkbox|radio|radiobutton)$/u.test(tagName);
}

function fieldValue(tagName, attributes) {
  if (!isChoiceField(tagName, attributes)) return decodeHtmlEntities(attributes.value ?? "");
  if (!Object.hasOwn(attributes, "checked")) return "";
  return decodeHtmlEntities(attributes.value || "on");
}

function taglibAttributeIsDisabled(tagName, attributes) {
  if (!Object.hasOwn(attributes, "disabled")) return false;
  if (!tagName.includes(":")) return true;
  return attributes.disabled.trim().toLowerCase() !== "false";
}

function requestFieldMetadata(tagName, attributes, requestValue, disabledByFieldset = false) {
  const type = (attributes.type ?? "").trim().toLowerCase();
  if (disabledByFieldset || taglibAttributeIsDisabled(tagName, attributes)) {
    return { submittable: false, requestChoice: false, requestValue: "" };
  }
  if (tagName === "button" || (tagName === "input" && type === "submit")) {
    const buttonType = type || "submit";
    return buttonType === "submit"
      ? { submittable: true, requestChoice: true, requestValue: "" }
      : { submittable: false, requestChoice: false, requestValue: "" };
  }
  if (tagName === "input" && ["button", "reset", "image"].includes(type)) {
    return { submittable: false, requestChoice: false, requestValue: "" };
  }
  return {
    submittable: true,
    requestChoice: isChoiceField(tagName, attributes),
    requestValue,
  };
}

function matchingClosingTag(tags, openingTag) {
  let depth = 0;
  for (const tag of tags) {
    if (tag.index <= openingTag.index || tag.name !== openingTag.name) continue;
    if (!tag.closing && !tag.selfClosing) depth += 1;
    else if (tag.closing && depth === 0) return tag;
    else if (tag.closing) depth -= 1;
  }
  return null;
}

function selectFieldValue(openingTag, attributes, tags, content) {
  const closing = matchingClosingTag(tags, openingTag);
  const end = closing?.index ?? content.length;
  const options = tags
    .filter((tag) => !tag.closing
      && tag.name === "option"
      && tag.index > openingTag.index
      && tag.index < end)
    .map((tag) => {
      const optionAttributes = attributesFrom(sourceForMatch(content, tag));
      const nextTag = content.indexOf("<", tag.end);
      const bodyEnd = nextTag === -1 || nextTag > end ? end : nextTag;
      return {
        disabled: Object.hasOwn(optionAttributes, "disabled"),
        selected: Object.hasOwn(optionAttributes, "selected"),
        value: Object.hasOwn(optionAttributes, "value")
          ? decodeHtmlEntities(optionAttributes.value)
          : decodeVisibleText(content.slice(tag.end, bodyEnd)),
      };
    })
    .filter((option) => !option.disabled);
  const selected = options.filter((option) => option.selected);
  if (Object.hasOwn(attributes, "multiple")) {
    return selected.length === 1 ? selected[0].value : "";
  }
  return (selected.at(-1) ?? options[0])?.value ?? "";
}

function textareaFieldValue(openingTag, content) {
  const closing = rawClosingTag(content, "textarea", openingTag.end);
  if (!closing) return "";
  let value = content.slice(openingTag.end, closing.start).replace(/^\r?\n/u, "");
  if (/\$\{|%\{|<%/u.test(value)) return "";
  value = value.replace(/\r\n?/gu, "\n");
  return decodeHtmlEntities(value);
}

function nativeFieldValue(openingTag, attributes, tags, content) {
  if (openingTag.name === "select") return selectFieldValue(openingTag, attributes, tags, content);
  if (openingTag.name === "textarea") return textareaFieldValue(openingTag, content);
  return fieldValue(openingTag.name, attributes);
}

function disabledFieldsetContexts(tags, content) {
  const contexts = [];
  const stack = [];
  for (const tag of tags) {
    if (tag.name !== "fieldset") continue;
    if (!tag.closing) {
      if (!tag.selfClosing) {
        const attributes = attributesFrom(sourceForMatch(content, tag));
        stack.push({ tag, start: tag.end, disabled: Object.hasOwn(attributes, "disabled") });
      }
      continue;
    }
    const opening = stack.pop();
    if (opening?.disabled) contexts.push({ ...opening, end: tag.index });
  }
  for (const opening of stack) {
    if (opening.disabled) contexts.push({ ...opening, end: content.length });
  }
  for (const context of contexts) {
    const legend = tags.find((tag) => !tag.closing
      && tag.name === "legend"
      && tag.index >= context.start
      && tag.index < context.end);
    const closing = legend && !legend.selfClosing ? matchingClosingTag(tags, legend) : null;
    context.legendRange = legend && closing && closing.index < context.end
      ? [legend.index, closing.end]
      : null;
  }
  return contexts.sort((left, right) => left.start - right.start);
}

function disabledByFieldset(contexts, offset) {
  return contexts.some((context) => offset >= context.start
    && offset < context.end
    && !(context.legendRange
      && offset >= context.legendRange[0]
      && offset < context.legendRange[1]));
}

export function parseJsp(content, filePath) {
  const locator = createEvidenceLocator(content, filePath);
  const requests = [];
  const includes = [];
  const scripts = [];
  const fields = [];
  const pageWebPath = webPathForFile(filePath);
  const scanSources = jspScanSources(content);
  const markupStructure = scanSources.structure;
  const tags = scanSources.tags;
  const formRanges = formBodyRanges(tags);
  const disabledFieldsets = disabledFieldsetContexts(tags, content);
  const textEntries = extractVisibleTextEntries(markupStructure, locator);
  const taglibRequests = extractTaglibRequests(tags, formRanges, content, locator, pageWebPath);

  for (const match of tags) {
    if (match.closing || match.name !== "form") continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesFrom(source);
    const target = markupRequestTarget(attributes.action ?? "", pageWebPath);
    if (!target.url) continue;
    requests.push({
      kind: "form",
      url: target.url,
      method: staticHttpMethod(attributes.method, "GET"),
      ...requestTargetMetadata(target),
      evidence: requestEvidence(locator, match, "action", source),
      offset: match.index,
      formId: attributes.id,
      formRange: formRanges.get(match.index) ?? null,
    });
  }

  for (const match of tags) {
    if (match.closing || match.name !== "a") continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesFrom(source);
    if (!Object.hasOwn(attributes, "href")) continue;
    const target = markupRequestTarget(attributes.href, pageWebPath);
    if (!target.url) continue;
    requests.push({
      kind: "link",
      url: target.url,
      method: "GET",
      ...requestTargetMetadata(target),
      evidence: requestEvidence(locator, match, "href", source),
      offset: match.index,
    });
  }

  for (const directive of scanSources.includeDirectives) {
    includes.push({
      path: directive.file,
      evidence: locator.at(directive.index, directive.source.length),
      offset: directive.index,
    });
  }
  for (const match of tags) {
    if (match.closing || match.name !== "jsp:include") continue;
    const source = sourceForMatch(content, match);
    const page = attributesFrom(source).page;
    if (!page) continue;
    if (!markupRequestTarget(page, pageWebPath).url) continue;
    includes.push({ path: page, evidence: locator.at(match.index, source.length), offset: match.index });
  }
  for (const match of tags) {
    if (match.closing || match.name !== "script") continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesFrom(source);
    if (!isJavaScriptScript(attributes) || !Object.hasOwn(attributes, "src")) continue;
    const target = markupRequestTarget(attributes.src, pageWebPath);
    if (!target.url) continue;
    scripts.push({
      path: target.url,
      ...(Object.hasOwn(target, "relativeUrl") ? { relativePath: target.relativeUrl } : {}),
      evidence: locator.at(match.index, source.length),
      offset: match.index,
    });
  }

  const nativeFieldTags = new Set(["input", "select", "textarea", "button"]);
  for (const match of tags) {
    if (match.closing || !nativeFieldTags.has(match.name)) continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesFrom(source);
    if (!attributes.name) continue;
    const value = nativeFieldValue(match, attributes, tags, content);
    const requestMetadata = requestFieldMetadata(
      match.name,
      attributes,
      value,
      disabledByFieldset(disabledFieldsets, match.index),
    );
    fields.push({
      name: attributes.name,
      value,
      ...requestMetadata,
      evidence: requestEvidence(locator, match, "name", source),
      formOwner: Object.hasOwn(attributes, "form") ? attributes.form : undefined,
      offset: match.index,
    });
  }
  const taglibFieldTags = new Set([
    "html:hidden", "html:text", "html:textarea", "html:select", "html:radio", "html:checkbox",
    "s:hidden", "s:textfield", "s:textarea", "s:select", "s:radio", "s:checkbox",
    "form:hidden", "form:input", "form:textarea", "form:select", "form:radiobutton", "form:checkbox",
  ]);
  for (const match of tags) {
    if (match.closing || !taglibFieldTags.has(match.name)) continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesFrom(source);
    const name = attributes.property ?? attributes.name ?? attributes.path ?? "";
    if (!name) continue;
    const attributeName = attributes.property !== undefined
      ? "property"
      : attributes.name !== undefined ? "name" : "path";
    const value = fieldValue(match.name, attributes);
    const requestMetadata = requestFieldMetadata(
      match.name,
      attributes,
      value,
      disabledByFieldset(disabledFieldsets, match.index),
    );
    fields.push({
      name,
      value,
      ...requestMetadata,
      evidence: requestEvidence(locator, match, attributeName, source),
      formOwner: Object.hasOwn(attributes, "form") ? attributes.form : undefined,
      offset: match.index,
    });
  }

  const scriptRequests = extractJavaScriptRequests(
    content,
    filePath,
    pageWebPath,
    locator,
    scanSources.javaScript,
  ).map((request) => ({
    ...request,
    offset: locator.offsetAt(request.evidence.line, request.evidence.column),
  }));

  const sortedFields = fields.sort((left, right) => left.offset - right.offset);
  const unownedFields = [];
  const fieldsByOwner = new Map();
  for (const field of sortedFields) {
    if (field.formOwner === undefined) {
      unownedFields.push(field);
      continue;
    }
    if (!field.formOwner) continue;
    const owned = fieldsByOwner.get(field.formOwner) ?? [];
    owned.push(field);
    fieldsByOwner.set(field.formOwner, owned);
  }
  const allRequests = [...requests, ...taglibRequests, ...scriptRequests]
    .filter((request) => request.url)
    .sort((left, right) => left.offset - right.offset);
  const formIdCounts = countFormIds(tags, content);
  const formTags = tags.filter((tag) => !tag.closing && FORM_TAG_NAMES.has(tag.name));
  const assignedFieldOffsets = new Set();
  for (const formTag of formTags) {
    const formId = attributesFrom(sourceForMatch(content, formTag)).id;
    for (const field of fieldsForForm(
      formRanges.get(formTag.index) ?? null,
      formId,
      unownedFields,
      fieldsByOwner,
      formIdCounts,
    )) {
      if (field.submittable) assignedFieldOffsets.add(field.offset);
    }
  }

  return {
    formCount: formTags.length,
    unassignedFieldCount: sortedFields.filter((field) => !assignedFieldOffsets.has(field.offset)).length,
    visibleText: textEntries.map((entry) => entry.text).join(" "),
    textEntries,
    requests: allRequests
      .map(({ offset: _offset, formId, formRange, ...request }) => request.kind === "form"
        ? {
            ...request,
            parameters: mergeRequestParameters(
              request.parameters,
              parametersForForm(
                formRange,
                formId,
                unownedFields,
                fieldsByOwner,
                formIdCounts,
              ),
            ),
          }
        : request),
    includes: includes.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
    scripts: scripts.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
    fields: sortedFields.map(({
      offset: _offset,
      formOwner: _formOwner,
      submittable: _submittable,
      requestChoice: _requestChoice,
      requestValue: _requestValue,
      ...entry
    }) => entry),
  };
}
