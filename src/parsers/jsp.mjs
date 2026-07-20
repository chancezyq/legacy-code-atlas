import { createEvidenceLocator } from "../evidence.mjs";

function attributesFrom(tag) {
  const attributes = {};
  const pattern = /([\w:-]+)\s*=\s*(["'])(.*?)\2/gs;
  for (const match of tag.matchAll(pattern)) attributes[match[1].toLowerCase()] = match[3];
  return attributes;
}

export function webPathForFile(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").replace(/^\.\//, "");
  for (const marker of ["src/main/webapp/", "WebRoot/", "WebContent/", "web/"]) {
    const index = normalized.indexOf(marker);
    if (index !== -1) return `/${normalized.slice(index + marker.length)}`.replace(/\/{2,}/g, "/");
  }
  return `/${normalized}`.replace(/\/{2,}/g, "/");
}

export function normalizeRequestUrl(rawUrl, basePath = "") {
  if (!rawUrl) return "";
  const cUrl = rawUrl.match(/<c:url\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1[^>]*\/?\s*>/is);
  let value = cUrl ? cUrl[2] : rawUrl;
  value = value
    .replace(/\$\{\s*pageContext\.request\.contextPath\s*}/g, "")
    .replace(/\$\{\s*(?:ctx|contextPath)\s*}/g, "")
    .trim();
  if (!value
    || /\$\{|%\{/.test(value)
    || value.startsWith("#")
    || value.startsWith("//")
    || /^(?:https?:|javascript:|mailto:|tel:|data:)/i.test(value)) return "";
  const pathMatch = value.match(/\/[\w./-]+/);
  if (!pathMatch) {
    const relative = value.split(/[?#]/, 1)[0];
    if (!relative || !basePath) return relative;
    return new URL(relative, `http://legacy.local${basePath}`).pathname;
  }
  return pathMatch[0].replace(/[?#].*$/, "");
}

function requestEvidence(locator, match, attributeName) {
  const localOffset = attributeName ? match[0].toLowerCase().indexOf(attributeName.toLowerCase()) : 0;
  return locator.at(match.index + Math.max(0, localOffset), match[0].length);
}

function strutsTaglibUrl(attributes, extension) {
  const action = (attributes.action ?? "").trim();
  if (!action) return "";
  if (/^(?:https?:|javascript:|mailto:|tel:|data:)/i.test(action) || /\$\{|%\{/.test(action)) return "";
  if (extension === ".do") {
    const rooted = action.startsWith("/") || action.startsWith("${") || action.startsWith("<c:url")
      ? action
      : `/${action}`;
    const normalized = normalizeRequestUrl(rooted);
    return normalized ? `${normalized.replace(/\.do$/i, "")}.do` : "";
  }
  const namespace = (attributes.namespace ?? "").trim();
  if (/\$\{|%\{/.test(namespace)) return "";
  const prefix = namespace && namespace !== "/" ? `/${namespace.replace(/^\/+|\/+$/g, "")}` : "";
  const normalizedAction = action.replace(/^\/+/, "");
  return `${prefix}/${normalizedAction}${normalizedAction.toLowerCase().endsWith(extension) ? "" : extension}`
    .replace(/\/{2,}/g, "/");
}

function extractStrutsTaglibRequests(content, locator, pageWebPath) {
  const requests = [];
  for (const match of content.matchAll(/<(html:form|html:link|html:rewrite|s:form|s:url|s:a)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    const attributes = attributesFrom(match[0]);
    const isStruts1 = tag.startsWith("html:");
    const isForm = tag.endsWith(":form");
    const isUrl = tag === "s:url";
    const isLink = tag.endsWith(":link") || tag === "s:a" || tag === "html:rewrite" || isUrl;
    const staticValue = attributes.page
      ?? attributes.href
      ?? (tag === "html:rewrite" || (isUrl && !attributes.action) ? attributes.value : undefined);
    const url = staticValue !== undefined
      ? normalizeRequestUrl(staticValue, pageWebPath)
      : isStruts1
        ? strutsTaglibUrl(attributes, ".do")
        : strutsTaglibUrl(attributes, ".action");
    if (!url || (!isForm && !isLink)) continue;
    requests.push({
      kind: isForm ? "form" : "link",
      url: normalizeRequestUrl(url, pageWebPath),
      method: isForm ? (attributes.method ?? "GET").toUpperCase() : "GET",
      evidence: requestEvidence(locator, match, attributes.action ? "action" : attributes.page ? "page" : attributes.value ? "value" : "href"),
      offset: match.index,
    });
  }
  return requests;
}

export function extractJavaScriptRequests(
  content,
  filePath,
  basePath = "",
  locator = createEvidenceLocator(content, filePath),
) {
  locator.assertSource(content, filePath);
  const requests = [];

  for (const match of content.matchAll(/\bfetch\s*\(\s*(["'])(.*?)\1/gis)) {
    requests.push({
      kind: "fetch",
      url: normalizeRequestUrl(match[2], basePath),
      method: "GET",
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  for (const match of content.matchAll(/\.open\s*\(\s*(["'])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*(["'])(.*?)\3/gis)) {
    requests.push({
      kind: "xhr",
      url: normalizeRequestUrl(match[4], basePath),
      method: match[2].toUpperCase(),
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  for (const match of content.matchAll(/\$\.ajax\s*\(\s*\{([\s\S]*?)\}\s*\)/gi)) {
    const body = match[1];
    const urlMatch = body.match(/\burl\s*:\s*(["'])(.*?)\1/is);
    if (!urlMatch) continue;
    const methodMatch = body.match(/\b(?:method|type)\s*:\s*(["'])(GET|POST|PUT|PATCH|DELETE)\1/i);
    requests.push({
      kind: "ajax",
      url: normalizeRequestUrl(urlMatch[2], basePath),
      method: (methodMatch?.[2] ?? "GET").toUpperCase(),
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  return requests
    .filter((request) => request.url)
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

function extractVisibleTextEntries(content, locator) {
  const masked = content
    .replace(/<%--[\s\S]*?--%>/g, blankRegion)
    .replace(/<%@?[\s\S]*?%>/g, blankRegion)
    .replace(/<script\b[\s\S]*?<\/script>/gi, blankRegion)
    .replace(/<style\b[\s\S]*?<\/style>/gi, blankRegion);
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

export function parseJsp(content, filePath) {
  const locator = createEvidenceLocator(content, filePath);
  const requests = [];
  const includes = [];
  const scripts = [];
  const fields = [];
  const pageWebPath = webPathForFile(filePath);
  const textEntries = extractVisibleTextEntries(content, locator);
  const taglibRequests = extractStrutsTaglibRequests(content, locator, pageWebPath);

  for (const match of content.matchAll(/<form\b[^>]*>/gi)) {
    const attributes = attributesFrom(match[0]);
    if (!attributes.action) continue;
    requests.push({
      kind: "form",
      url: normalizeRequestUrl(attributes.action, pageWebPath),
      method: (attributes.method ?? "GET").toUpperCase(),
      evidence: requestEvidence(locator, match, "action"),
      offset: match.index,
    });
  }

  for (const match of content.matchAll(/<a\b[^>]*>/gi)) {
    const attributes = attributesFrom(match[0]);
    if (!attributes.href) continue;
    requests.push({
      kind: "link",
      url: normalizeRequestUrl(attributes.href, pageWebPath),
      method: "GET",
      evidence: requestEvidence(locator, match, "href"),
      offset: match.index,
    });
  }

  for (const match of content.matchAll(/<%@\s*include\b[^%]*\bfile\s*=\s*(["'])(.*?)\1[^%]*%>/gi)) {
    includes.push({ path: match[2], evidence: locator.at(match.index, match[0].length), offset: match.index });
  }
  for (const match of content.matchAll(/<jsp:include\b[^>]*\bpage\s*=\s*(["'])(.*?)\1[^>]*\/?\s*>/gi)) {
    includes.push({ path: match[2], evidence: locator.at(match.index, match[0].length), offset: match.index });
  }
  for (const match of content.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const scriptPath = normalizeRequestUrl(match[2], pageWebPath);
    if (!scriptPath) continue;
    scripts.push({ path: scriptPath, evidence: locator.at(match.index, match[0].length), offset: match.index });
  }

  for (const match of content.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/gi)) {
    const attributes = attributesFrom(match[0]);
    if (!attributes.name) continue;
    fields.push({
      name: attributes.name,
      value: attributes.value ?? "",
      evidence: requestEvidence(locator, match, "name"),
      offset: match.index,
    });
  }
  for (const match of content.matchAll(/<(?:html:(?:hidden|text|textarea|select|radio|checkbox)|s:(?:hidden|textfield|textarea|select|radio|checkbox))\b[^>]*>/gi)) {
    const attributes = attributesFrom(match[0]);
    const name = attributes.property ?? attributes.name ?? "";
    if (!name) continue;
    fields.push({
      name,
      value: attributes.value ?? "",
      evidence: requestEvidence(locator, match, attributes.property !== undefined ? "property" : "name"),
      offset: match.index,
    });
  }

  const scriptRequests = extractJavaScriptRequests(content, filePath, pageWebPath, locator).map((request) => ({
    ...request,
    offset: locator.offsetAt(request.evidence.line, request.evidence.column),
  }));

  const formParameters = Object.fromEntries(
    fields.filter((field) => field.value).map((field) => [field.name, field.value]),
  );
  return {
    visibleText: textEntries.map((entry) => entry.text).join(" "),
    textEntries,
    requests: [...requests, ...taglibRequests, ...scriptRequests]
      .filter((request) => request.url)
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...request }) => request.kind === "form"
        ? { ...request, parameters: formParameters }
        : request),
    includes: includes.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
    scripts: scripts.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
    fields: fields.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...entry }) => entry),
  };
}
