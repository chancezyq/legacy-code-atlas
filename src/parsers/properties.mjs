import { createEvidenceLocator } from "../evidence.mjs";

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_CHARACTERS = 64 * 1024;

function continuation(line) {
  let slashes = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function decodeEscapes(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\" || index + 1 >= value.length) {
      result += value[index];
      continue;
    }
    const escaped = value[index + 1];
    index += 1;
    if (escaped === "t") result += "\t";
    else if (escaped === "n") result += "\n";
    else if (escaped === "r") result += "\r";
    else if (escaped === "f") result += "\f";
    else if (escaped === "u" && /^[0-9a-fA-F]{4}$/u.test(value.slice(index + 1, index + 5))) {
      result += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
    } else result += escaped;
  }
  return result;
}

function splitEntry(line) {
  let escaped = false;
  let separator = -1;
  let whitespaceSeparator = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "=" || character === ":" || /\s/u.test(character)) {
      separator = index;
      whitespaceSeparator = /\s/u.test(character);
      break;
    }
  }
  if (separator === -1) return { key: decodeEscapes(line), value: "" };
  let valueStart = separator + 1;
  if (whitespaceSeparator) {
    while (/\s/u.test(line[valueStart] ?? "")) valueStart += 1;
    if (line[valueStart] === "=" || line[valueStart] === ":") valueStart += 1;
  }
  while (/\s/u.test(line[valueStart] ?? "")) valueStart += 1;
  return {
    key: decodeEscapes(line.slice(0, separator).trimEnd()),
    value: decodeEscapes(line.slice(valueStart)),
  };
}

export function parseProperties(content, filePath) {
  const locator = createEvidenceLocator(content, filePath, { recognizeBareCarriageReturns: true });
  const physicalLines = content.split(/\r\n|\n|\r/u);
  const lineBreaks = [...content.matchAll(/\r\n|\n|\r/gu)].map((match) => match[0].length);
  const offsets = [];
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < physicalLines.length; lineIndex += 1) {
    const line = physicalLines[lineIndex];
    offsets.push(cursor);
    cursor += line.length + (lineBreaks[lineIndex] ?? 0);
  }
  const entries = [];
  const warnings = [];

  for (let index = 0; index < physicalLines.length;) {
    const startIndex = index;
    let logical = physicalLines[index];
    while (continuation(logical) && index + 1 < physicalLines.length) {
      logical = logical.slice(0, -1) + physicalLines[index + 1].replace(/^\s+/u, "");
      index += 1;
    }
    index += 1;
    const trimmed = logical.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    if (entries.length >= MAX_ENTRIES) {
      warnings.push(`properties entries truncated in ${filePath} after ${MAX_ENTRIES} entries`);
      break;
    }
    const parsed = splitEntry(trimmed);
    if (!parsed.key) continue;
    if (parsed.key.length > MAX_ENTRY_CHARACTERS || parsed.value.length > MAX_ENTRY_CHARACTERS) {
      warnings.push(`oversized properties entry omitted in ${filePath} at line ${startIndex + 1}`);
      continue;
    }
    entries.push({
      ...parsed,
      evidence: locator.at(offsets[startIndex] + physicalLines[startIndex].search(/\S/u), physicalLines[startIndex].length),
    });
  }
  return { entries, warnings };
}
