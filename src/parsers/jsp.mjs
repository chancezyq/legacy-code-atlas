import { createEvidenceLocator } from "../evidence.mjs";
import { replaceUnsafeTextControls } from "../text-safety.mjs";
import { extractJavaScriptRequests } from "./javascript-requests.mjs";
import {
  URL_SCHEME,
  normalizeRequestUrl,
  requestTarget,
  requestTargetMetadata,
  staticHttpMethod,
} from "./request-target.mjs";
import { maskedSource, sourceWithinRanges } from "./source-masking.mjs";

export { extractJavaScriptRequests, normalizeRequestUrl };

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
      while (cursor < tag.length && tag[cursor] !== quote) {
        if (tag[cursor] === "<" && plausibleEmbeddedTagStart(tag, cursor)) {
          const embedded = tagEndOffset(tag, cursor);
          if (embedded.closed) {
            cursor = embedded.end;
            continue;
          }
        }
        cursor += 1;
      }
      entries.push({ name, value: tag.slice(valueStart, cursor), index });
      if (tag[cursor] === quote) cursor += 1;
      continue;
    }
    const valueStart = cursor;
    if (tag[cursor] === "<" && plausibleEmbeddedTagStart(tag, cursor)) {
      const embedded = tagEndOffset(tag, cursor);
      if (embedded.closed) cursor = embedded.end;
    }
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

// A tag's attributes are parsed several times during one parseJsp call
// (form, link and field loops, form-id counting, fieldset contexts,
// evidence lookup), and attributeEntriesFrom walks the tag source
// character by character. Tag objects are fresh per parse, are never
// serialized, and no caller mutates the parsed attributes, so parsing
// each tag's attributes once and sharing the result is exactly
// equivalent and removes most of that repeated work. Whichever of the
// entries or the map is needed first populates the shared entries.
function attributeEntriesForTag(content, match) {
  return match.attributeEntries ??= attributeEntriesFrom(sourceForMatch(content, match));
}

function attributesForTag(content, match) {
  if (!match.attributes) {
    const attributes = {};
    for (const entry of attributeEntriesForTag(content, match)) attributes[entry.name] = entry.value;
    match.attributes = attributes;
  }
  return match.attributes;
}

// Hoisted out of decodeHtmlEntities: the table was rebuilt on every
// call (once per request URL and per field value), for no benefit.
const NAMED_HTML_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

function decodeHtmlEntities(value) {
  const named = NAMED_HTML_ENTITIES;
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
    // Reuse the tag's cached entries when they exist (populated by an
    // earlier attributesForTag call for the same tag); otherwise scan
    // once and cache, so a later attributes lookup reuses this scan.
    const entries = match.attributeEntries ??= attributeEntriesFrom(source);
    for (const attribute of entries) {
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
      if (character === "<" && plausibleEmbeddedTagStart(content, index)) {
        const embedded = tagEndOffset(content, index);
        if (embedded.closed) {
          index = embedded.end - 1;
          continue;
        }
      }
      if (character === quote) quote = "";
      continue;
    }
    if (character === "<" && plausibleEmbeddedTagStart(content, index)) {
      const embedded = tagEndOffset(content, index);
      if (embedded.closed) {
        index = embedded.end - 1;
        continue;
      }
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

function plausibleEmbeddedTagStart(content, start) {
  return /^<[A-Za-z][\w.-]*:[A-Za-z][\w.-]*(?=[\s/>])/u.test(content.slice(start));
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
    const attributes = attributesForTag(content, match);
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
    const action = (attributes.action ?? "").trim();
    const struts2ActionRelative = tag.startsWith("s:")
      && action
      && !action.includes("/")
      && !action.includes("\\")
      && !Object.hasOwn(attributes, "namespace");
    requests.push({
      kind: isForm ? "form" : "link",
      url: target.url,
      method: isForm ? staticHttpMethod(attributes.method, "POST") : "GET",
      ...requestTargetMetadata(target),
      ...(struts2ActionRelative ? { struts2ActionRelative: true } : {}),
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
    const id = attributesForTag(content, match).id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function decodeVisibleText(value) {
  // Fast path for plain text, the common case: every replacement below
  // needs one of $, & or < to trigger, and the whitespace collapse is
  // a no-op when the only whitespace is single ordinary spaces (any
  // other whitespace character would be collapsed to a space by the
  // slow path, as would a run of two spaces). Leading/trailing spaces
  // are still trimmed, exactly as the slow path's final trim does.
  if (!/[$&<]/.test(value) && !/[^\S ]/.test(value) && !/  /.test(value)) return value.trim();
  return value
    .replace(/\$\{[^}]*}/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function extractVisibleTextEntries(masked, locator, tags) {
  const entries = [];
  const addRange = (start, end) => {
    if (end <= start) return;
    const source = masked.slice(start, end);
    const text = decodeVisibleText(source);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const leadingWhitespace = source.search(/\S/u);
    const offset = start + Math.max(0, leadingWhitespace);
    entries.push({ text, evidence: locator.at(offset, source.length) });
  };
  let cursor = 0;
  for (const tag of tags) {
    if (tag.index > cursor) addRange(cursor, tag.index);
    cursor = Math.max(cursor, tag.end);
  }
  addRange(cursor, masked.length);
  return entries;
}

function isChoiceField(tagName, attributes) {
  const type = (attributes.type ?? "").trim().toLowerCase();
  return (tagName === "input" && (type === "checkbox" || type === "radio"))
    || /:(?:checkbox|radio|radiobutton)$/u.test(tagName);
}

function fieldValueState(value) {
  const decoded = decodeHtmlEntities(value);
  const runtimeDerived = /\$\{|%\{|<%|<[A-Za-z][\w.-]*:[A-Za-z][\w.-]*(?=[\s/>])/u.test(decoded);
  // A decoded value can legitimately contain control characters: numeric
  // entities such as &#13; decode to them, and a textarea's default text
  // keeps its newlines. Index validation rejects control characters in
  // every string, so without this step one such field would fail the
  // whole scan. Replace them with a space, as the properties parser does
  // for its values, and let the caller report the replacement.
  const clean = runtimeDerived ? "" : replaceUnsafeTextControls(decoded);
  return { value: clean, runtimeDerived, sanitized: !runtimeDerived && clean !== decoded };
}

function attributeFieldValueState(tagName, attributes) {
  if (!isChoiceField(tagName, attributes)) return fieldValueState(attributes.value ?? "");
  if (!Object.hasOwn(attributes, "checked")) return { value: "", runtimeDerived: false };
  return fieldValueState(attributes.value || "on");
}

function staticFieldName(value) {
  const name = replaceUnsafeTextControls(String(value ?? "")).trim();
  return name && !/\$\{|%\{|<%|<[^>]*>/u.test(name) ? name : "";
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

function selectFieldValueState(openingTag, attributes, tags, content) {
  const closing = matchingClosingTag(tags, openingTag);
  const end = closing?.index ?? content.length;
  const optionBoundaries = tags.filter((tag) => (
    tag.name === "option"
    && tag.index > openingTag.index
    && tag.index < end
  ));
  const options = optionBoundaries
    .flatMap((tag, index) => {
      if (tag.closing) return [];
      const optionAttributes = attributesForTag(content, tag);
      const bodyEnd = optionBoundaries[index + 1]?.index ?? end;
      const state = Object.hasOwn(optionAttributes, "value")
        ? fieldValueState(optionAttributes.value)
        : fieldValueState(content.slice(tag.end, bodyEnd));
      return [{
        disabled: Object.hasOwn(optionAttributes, "disabled"),
        selected: Object.hasOwn(optionAttributes, "selected"),
        value: state.runtimeDerived || Object.hasOwn(optionAttributes, "value")
          ? state.value
          : decodeVisibleText(state.value),
        runtimeDerived: state.runtimeDerived,
        sanitized: state.sanitized,
      }];
    })
    .filter((option) => !option.disabled);
  const selected = options.filter((option) => option.selected);
  if (Object.hasOwn(attributes, "multiple")) {
    return selected.length === 1
      ? selected[0]
      : { value: "", runtimeDerived: selected.some((option) => option.runtimeDerived), sanitized: false };
  }
  return selected.at(-1) ?? options[0] ?? { value: "", runtimeDerived: false };
}

function textareaFieldValueState(openingTag, content) {
  const closing = rawClosingTag(content, "textarea", openingTag.end);
  if (!closing) return { value: "", runtimeDerived: false };
  let value = content.slice(openingTag.end, closing.start).replace(/^\r?\n/u, "");
  value = value.replace(/\r\n?/gu, "\n");
  return fieldValueState(value);
}

function nativeFieldValueState(openingTag, attributes, tags, content) {
  if (openingTag.name === "select") return selectFieldValueState(openingTag, attributes, tags, content);
  if (openingTag.name === "textarea") return textareaFieldValueState(openingTag, content);
  return attributeFieldValueState(openingTag.name, attributes);
}

function disabledFieldsetContexts(tags, content) {
  const contexts = [];
  const stack = [];
  for (const tag of tags) {
    if (tag.name !== "fieldset") continue;
    if (!tag.closing) {
      if (!tag.selfClosing) {
        const attributes = attributesForTag(content, tag);
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
  const unresolvedFields = [];
  const warnings = [];
  let sanitizedFieldValues = 0;
  const pageWebPath = webPathForFile(filePath);
  const scanSources = jspScanSources(content);
  const markupStructure = scanSources.structure;
  const tags = scanSources.tags;
  const formRanges = formBodyRanges(tags);
  const disabledFieldsets = disabledFieldsetContexts(tags, content);
  const textEntries = extractVisibleTextEntries(markupStructure, locator, tags);
  const taglibRequests = extractTaglibRequests(tags, formRanges, content, locator, pageWebPath);

  for (const match of tags) {
    if (match.closing || match.name !== "form") continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesForTag(content, match);
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
    const attributes = attributesForTag(content, match);
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
    const page = attributesForTag(content, match).page;
    if (!page) continue;
    if (!markupRequestTarget(page, pageWebPath).url) continue;
    includes.push({ path: page, evidence: locator.at(match.index, source.length), offset: match.index });
  }
  for (const match of tags) {
    if (match.closing || match.name !== "script") continue;
    const source = sourceForMatch(content, match);
    const attributes = attributesForTag(content, match);
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
    const attributes = attributesForTag(content, match);
    if (!attributes.name) continue;
    const valueState = nativeFieldValueState(match, attributes, tags, content);
    if (valueState.sanitized) sanitizedFieldValues += 1;
    const value = valueState.value;
    const requestMetadata = requestFieldMetadata(
      match.name,
      attributes,
      value,
      disabledByFieldset(disabledFieldsets, match.index),
    );
    const fieldContext = {
      ...requestMetadata,
      runtimeDerivedValue: valueState.runtimeDerived,
      formOwner: Object.hasOwn(attributes, "form") ? attributes.form : undefined,
      offset: match.index,
    };
    const name = staticFieldName(attributes.name);
    if (!name) {
      const evidence = requestEvidence(locator, match, "name", source);
      warnings.push(`dynamic JSP field name omitted in ${filePath} at line ${evidence.line}`);
      if (requestMetadata.submittable) unresolvedFields.push(fieldContext);
      continue;
    }
    fields.push({
      name,
      value,
      element: match.name,
      inputType: (attributes.type ?? match.name).trim().toLowerCase(),
      runtimeDerived: valueState.runtimeDerived,
      required: Object.hasOwn(attributes, "required"),
      disabled: !requestMetadata.submittable && (Object.hasOwn(attributes, "disabled")
        || disabledByFieldset(disabledFieldsets, match.index)),
      choice: requestMetadata.requestChoice,
      ...fieldContext,
      evidence: requestEvidence(locator, match, "name", source),
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
    const attributes = attributesForTag(content, match);
    const rawName = attributes.property
      ?? attributes.name
      ?? attributes.path
      ?? (match.name.startsWith("s:") ? attributes.key : undefined)
      ?? "";
    if (!rawName) continue;
    const attributeName = attributes.property !== undefined
      ? "property"
      : attributes.name !== undefined
        ? "name"
        : attributes.path !== undefined ? "path" : "key";
    const valueState = attributeFieldValueState(match.name, attributes);
    if (valueState.sanitized) sanitizedFieldValues += 1;
    const value = valueState.value;
    const requestMetadata = requestFieldMetadata(
      match.name,
      attributes,
      value,
      disabledByFieldset(disabledFieldsets, match.index),
    );
    const fieldContext = {
      ...requestMetadata,
      runtimeDerivedValue: valueState.runtimeDerived,
      formOwner: Object.hasOwn(attributes, "form") ? attributes.form : undefined,
      offset: match.index,
    };
    const name = staticFieldName(rawName);
    if (!name) {
      const evidence = requestEvidence(locator, match, attributeName, source);
      warnings.push(`dynamic JSP field name omitted in ${filePath} at line ${evidence.line}`);
      if (requestMetadata.submittable) unresolvedFields.push(fieldContext);
      continue;
    }
    fields.push({
      name,
      value,
      element: match.name,
      inputType: match.name.split(":").at(-1),
      runtimeDerived: valueState.runtimeDerived,
      required: Object.hasOwn(attributes, "required"),
      disabled: !requestMetadata.submittable && Object.hasOwn(attributes, "disabled"),
      choice: requestMetadata.requestChoice,
      ...fieldContext,
      evidence: requestEvidence(locator, match, attributeName, source),
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
  const sortedUnresolvedFields = unresolvedFields.sort((left, right) => left.offset - right.offset);
  const unownedFields = [];
  const unownedUnresolvedFields = [];
  const fieldsByOwner = new Map();
  const unresolvedFieldsByOwner = new Map();
  const partitionByOwner = (field, unowned, byOwner) => {
    if (field.formOwner === undefined) {
      unowned.push(field);
      return;
    }
    if (!field.formOwner) return;
    const owned = byOwner.get(field.formOwner) ?? [];
    owned.push(field);
    byOwner.set(field.formOwner, owned);
  };
  for (const field of sortedFields) partitionByOwner(field, unownedFields, fieldsByOwner);
  for (const field of sortedUnresolvedFields) {
    partitionByOwner(field, unownedUnresolvedFields, unresolvedFieldsByOwner);
  }
  const allRequests = [...requests, ...taglibRequests, ...scriptRequests]
    .filter((request) => request.url)
    .sort((left, right) => left.offset - right.offset);
  const formIdCounts = countFormIds(tags, content);
  const formTags = tags.filter((tag) => !tag.closing && FORM_TAG_NAMES.has(tag.name));
  const assignedFieldOffsets = new Set();
  for (const formTag of formTags) {
    const formId = attributesForTag(content, formTag).id;
    for (const field of fieldsForForm(
      formRanges.get(formTag.index) ?? null,
      formId,
      unownedFields,
      fieldsByOwner,
      formIdCounts,
    )) {
      if (field.submittable) assignedFieldOffsets.add(field.offset);
    }
    for (const field of fieldsForForm(
      formRanges.get(formTag.index) ?? null,
      formId,
      unownedUnresolvedFields,
      unresolvedFieldsByOwner,
      formIdCounts,
    )) assignedFieldOffsets.add(field.offset);
  }

  if (sanitizedFieldValues > 0) {
    warnings.push(`JSP field control characters replaced in ${filePath} (${sanitizedFieldValues} fields)`);
  }

  return {
    formCount: formTags.length,
    unassignedFieldCount: [...sortedFields, ...sortedUnresolvedFields]
      .filter((field) => !assignedFieldOffsets.has(field.offset)).length,
    visibleText: textEntries.map((entry) => entry.text).join(" "),
    textEntries,
    requests: allRequests
      .map(({ offset: _offset, formId, formRange, ...request }) => {
        if (request.kind !== "form") return request;
        const formFields = fieldsForForm(
          formRange,
          formId,
          unownedFields,
          fieldsByOwner,
          formIdCounts,
        );
        const hasDynamicParameterNames = fieldsForForm(
          formRange,
          formId,
          unownedUnresolvedFields,
          unresolvedFieldsByOwner,
          formIdCounts,
        ).length > 0;
        const runtimeValueParameterNames = [...new Set(formFields
          .filter((field) => field.submittable && field.runtimeDerivedValue)
          .map((field) => field.name))];
        const parameters = mergeRequestParameters(
          request.parameters,
          parametersForForm(formRange, formId, unownedFields, fieldsByOwner, formIdCounts),
        );
        for (const name of runtimeValueParameterNames) {
          if (Object.hasOwn(parameters, name)) parameters[name] = "";
        }
        return {
          ...request,
          parameters,
          ...(runtimeValueParameterNames.length > 0 ? { runtimeValueParameterNames } : {}),
          ...(hasDynamicParameterNames ? {
            parametersComplete: false,
            hasDynamicParameterNames: true,
          } : {}),
        };
      }),
    includes: includes.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
    scripts: scripts.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
    fields: sortedFields.map(({
      offset: _offset,
      formOwner: _formOwner,
      requestChoice: _requestChoice,
      requestValue: _requestValue,
      runtimeDerivedValue: _runtimeDerivedValue,
      ...entry
    }) => entry),
    warnings,
  };
}
