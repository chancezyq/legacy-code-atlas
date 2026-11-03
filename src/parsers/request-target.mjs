// Request-target resolution shared by the JSP parser and the
// JavaScript-request extractor. Kept separate so the JSP parser file
// can shrink without either side duplicating URL handling.

const STATIC_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export function staticHttpMethod(value, fallback) {
  if (value === undefined) return fallback;
  const method = String(value).trim().toUpperCase();
  return STATIC_HTTP_METHODS.has(method) ? method : "";
}


function queryParametersFrom(query) {
  const parameters = {};
  let hasDynamicParameterNames = false;
  for (const [name, value] of new URLSearchParams(query)) {
    if (!name) continue;
    if (/\$\{|%\{|<%/u.test(name)) {
      hasDynamicParameterNames = true;
      continue;
    }
    const normalizedValue = /\$\{|%\{|<%/u.test(value) ? "" : value;
    if (!Object.hasOwn(parameters, name)) parameters[name] = normalizedValue;
    else if (parameters[name] !== normalizedValue) parameters[name] = "";
  }
  return { parameters, hasDynamicParameterNames };
}

export function requestTarget(rawUrl, basePath = "") {
  const emptyTarget = () => ({ url: "", parameters: {}, queryParameterNames: [] });
  if (rawUrl === undefined || rawUrl === null) return emptyTarget();
  const sourceValue = String(rawUrl).trim();
  const cUrl = sourceValue.match(/^<c:url\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1[^>]*\/\s*>$/is);
  let value = cUrl ? cUrl[2] : sourceValue;
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
  const { parameters, hasDynamicParameterNames } = queryParametersFrom(query);
  const queryParameterNames = Object.keys(parameters);
  if (/[<>]|\$\{|%\{|<%/u.test(relative)) return emptyTarget();
  const isRelative = !relative.startsWith("/");
  if (!basePath && isRelative) {
    return {
      url: relative,
      parameters,
      queryParameterNames,
      relativeUrl: withoutFragment,
      ...(hasDynamicParameterNames ? { hasDynamicParameterNames: true } : {}),
    };
  }
  try {
    const base = `http://legacy.local${String(basePath || "/").startsWith("/") ? basePath || "/" : `/${basePath}`}`;
    return {
      url: new URL(relative, base).pathname.replace(/\/{2,}/g, "/"),
      parameters,
      queryParameterNames,
      ...(hasDynamicParameterNames ? { hasDynamicParameterNames: true } : {}),
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

export function requestTargetMetadata(target) {
  return {
    ...requestParameters(target),
    ...(target.queryParameterNames.length > 0 ? { queryParameterNames: target.queryParameterNames } : {}),
    ...(target.hasDynamicParameterNames === true ? {
      parametersComplete: false,
      hasDynamicParameterNames: true,
    } : {}),
    ...(Object.hasOwn(target, "relativeUrl") ? { relativeUrl: target.relativeUrl } : {}),
  };
}
