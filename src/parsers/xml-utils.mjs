import { createEvidenceLocator } from "../evidence.mjs";

export function parseXmlAttributes(source) {
  const attributes = {};
  const pattern = /([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs;
  for (const match of source.matchAll(pattern)) attributes[match[1]] = match[3];
  return attributes;
}

export function findXmlElements(content, tagName, filePath, locator = createEvidenceLocator(content, filePath)) {
  locator.assertSource(content, filePath);
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}(?=\\s|\\/?>)([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${escaped}\\s*>)`, "gi");
  return [...content.matchAll(pattern)].map((match) => ({
    tag: tagName,
    attributes: parseXmlAttributes(match[1]),
    inner: match[2] ?? "",
    raw: match[0],
    offset: match.index,
    evidence: locator.at(match.index, match[0].length),
  }));
}

export function findXmlText(content, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, "i"));
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1").trim() : "";
}

export function withoutXmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

export function xmlStructureWarnings(content, filePath, rootTag) {
  const warnings = [];
  const escaped = rootTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasRootStart = new RegExp(`<${escaped}(?=\\s|>)`, "i").test(content);
  const hasRootEnd = new RegExp(`<\\/${escaped}\\s*>`, "i").test(content);

  if (hasRootStart && !hasRootEnd) warnings.push(`malformed XML in ${filePath}: unclosed <${rootTag}>`);
  if (content.lastIndexOf("<!--") > content.lastIndexOf("-->")) {
    warnings.push(`malformed XML in ${filePath}: unclosed comment`);
  }
  if (content.lastIndexOf("<![CDATA[") > content.lastIndexOf("]]>") ) {
    warnings.push(`malformed XML in ${filePath}: unclosed CDATA`);
  }
  return warnings;
}
