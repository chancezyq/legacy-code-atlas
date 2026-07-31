import { createEvidenceLocator } from "../evidence.mjs";

const NON_TYPE_STATEMENT_KEYWORDS = new Set([
  "assert",
  "break",
  "case",
  "continue",
  "else",
  "return",
  "throw",
  "yield",
]);

const TYPE_DECLARATION_MODIFIERS = new Set([
  "abstract",
  "final",
  "non-sealed",
  "private",
  "protected",
  "public",
  "sealed",
  "static",
  "strictfp",
]);

function javaUnicodeEscapes(content) {
  const escapes = new Map();
  let backslashRun = 0;
  let previousFromUnicodeEscape = false;
  for (let index = 0; index < content.length;) {
    if (content[index] !== "\\") {
      backslashRun = 0;
      previousFromUnicodeEscape = false;
      index += 1;
      continue;
    }

    let hexStart = index + 1;
    const eligible = previousFromUnicodeEscape || backslashRun % 2 === 0;
    if (eligible && content[hexStart] === "u") {
      while (content[hexStart] === "u") hexStart += 1;
      const hex = content.slice(hexStart, hexStart + 4);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        const character = String.fromCharCode(Number.parseInt(hex, 16));
        const length = hexStart + 4 - index;
        escapes.set(index, { character, length });
        backslashRun = 0;
        previousFromUnicodeEscape = true;
        index += length;
        continue;
      }
    }

    backslashRun += 1;
    previousFromUnicodeEscape = false;
    index += 1;
  }
  return escapes;
}

function textBlockDelimiterLength(content, escapes, index) {
  let cursor = index;
  for (let count = 0; count < 3; count += 1) {
    const escape = escapes.get(cursor);
    const character = escape?.character ?? content[cursor];
    if (character !== '"') return 0;
    cursor += escape?.length ?? 1;
  }
  return cursor - index;
}

function sourceSpan(content, index, length, translatedCharacter = "") {
  const span = content.slice(index, index + length);
  if ((translatedCharacter === "\n" || translatedCharacter === "\r") && length > 1) {
    return translatedCharacter + " ".repeat(length - 1);
  }
  return span;
}

function blankSpan(content, index, length, translatedCharacter = "") {
  return sourceSpan(content, index, length, translatedCharacter).replace(/[^\r\n]/g, " ");
}

function translateJavaUnicodeSource(content) {
  const unicodeEscapes = javaUnicodeEscapes(content);
  if (unicodeEscapes.size === 0) return { source: content, rawOffsets: null };
  const rawOffsets = [];
  let source = "";
  for (let rawOffset = 0; rawOffset < content.length;) {
    rawOffsets.push(rawOffset);
    const escape = unicodeEscapes.get(rawOffset);
    if (escape) {
      source += escape.character;
      rawOffset += escape.length;
    } else {
      source += content[rawOffset];
      rawOffset += 1;
    }
  }
  rawOffsets.push(content.length);
  return { source, rawOffsets };
}

function stripJavaCommentsWithEscapes(content, unicodeEscapes) {
  let output = "";
  let state = "code";
  for (let index = 0; index < content.length; index += 1) {
    const escape = unicodeEscapes.get(index);
    const character = escape?.character ?? content[index];
    const length = escape?.length ?? 1;
    const nextIndex = index + length;
    const nextEscape = unicodeEscapes.get(nextIndex);
    const next = nextEscape?.character ?? content[nextIndex];
    const nextLength = nextEscape?.length ?? 1;
    if (state === "code") {
      const delimiterLength = textBlockDelimiterLength(content, unicodeEscapes, index);
      if (character === "/" && next === "/") {
        const commentStartLength = length + nextLength;
        output += blankSpan(content, index, commentStartLength);
        index += commentStartLength - 1;
        state = "line-comment";
      } else if (character === "/" && next === "*") {
        const commentStartLength = length + nextLength;
        output += blankSpan(content, index, commentStartLength);
        index += commentStartLength - 1;
        state = "block-comment";
      } else if (delimiterLength > 0) {
        output += content.slice(index, index + delimiterLength);
        index += delimiterLength - 1;
        state = "text-block";
      } else {
        output += sourceSpan(content, index, length, character);
        if (character === '"') state = "string";
        else if (character === "'") state = "character";
        index += length - 1;
      }
    } else if (state === "line-comment") {
      output += blankSpan(content, index, length, character);
      if (character === "\n" || character === "\r") state = "code";
      index += length - 1;
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        const commentEndLength = length + nextLength;
        output += blankSpan(content, index, commentEndLength);
        index += commentEndLength - 1;
        state = "code";
      } else {
        output += blankSpan(content, index, length, character);
        index += length - 1;
      }
    } else if (state === "text-block") {
      const delimiterLength = textBlockDelimiterLength(content, unicodeEscapes, index);
      if (delimiterLength > 0) {
        output += content.slice(index, index + delimiterLength);
        index += delimiterLength - 1;
        state = "code";
      } else if (character === "\\" && next !== undefined) {
        output += sourceSpan(content, index, length, character);
        output += sourceSpan(content, nextIndex, nextLength, next);
        index += length + nextLength - 1;
      } else {
        output += sourceSpan(content, index, length, character);
        index += length - 1;
      }
    } else {
      output += sourceSpan(content, index, length, character);
      if (character === "\\" && next !== undefined) {
        output += sourceSpan(content, nextIndex, nextLength, next);
        index += length + nextLength - 1;
      } else if ((state === "string" && character === '"') || (state === "character" && character === "'")) {
        state = "code";
        index += length - 1;
      } else {
        index += length - 1;
      }
    }
  }
  return output;
}

export function stripJavaComments(content) {
  return stripJavaCommentsWithEscapes(content, javaUnicodeEscapes(content));
}

const NO_JAVA_UNICODE_ESCAPES = new Map();

function maskTranslatedJavaStrings(content) {
  let output = "";
  let state = "code";
  const unicodeEscapes = NO_JAVA_UNICODE_ESCAPES;
  for (let index = 0; index < content.length; index += 1) {
    const escape = unicodeEscapes.get(index);
    const character = escape?.character ?? content[index];
    const length = escape?.length ?? 1;
    const nextIndex = index + length;
    const nextEscape = unicodeEscapes.get(nextIndex);
    const next = nextEscape?.character ?? content[nextIndex];
    const nextLength = nextEscape?.length ?? 1;
    if (state === "code") {
      const delimiterLength = textBlockDelimiterLength(content, unicodeEscapes, index);
      if (delimiterLength > 0) {
        output += blankSpan(content, index, delimiterLength);
        index += delimiterLength - 1;
        state = "text-block";
      } else if (character === '"' || character === "'") {
        state = character === '"' ? "string" : "character";
        output += blankSpan(content, index, length, character);
        index += length - 1;
      } else {
        output += sourceSpan(content, index, length, character);
        index += length - 1;
      }
    } else {
      const delimiterLength = state === "text-block"
        ? textBlockDelimiterLength(content, unicodeEscapes, index)
        : 0;
      if (delimiterLength > 0) {
        output += blankSpan(content, index, delimiterLength);
        index += delimiterLength - 1;
        state = "code";
      } else if (character === "\\" && next !== undefined) {
        output += blankSpan(content, index, length, character);
        output += blankSpan(content, nextIndex, nextLength, next);
        index += length + nextLength - 1;
      } else if ((state === "string" && character === '"') || (state === "character" && character === "'")) {
        output += blankSpan(content, index, length, character);
        index += length - 1;
        state = "code";
      } else {
        output += blankSpan(content, index, length, character);
        index += length - 1;
      }
    }
  }
  return output;
}

function matchingDelimiter(masked, openOffset, openCharacter, closeCharacter) {
  let depth = 0;
  for (let index = openOffset; index < masked.length; index += 1) {
    if (masked[index] === openCharacter) depth += 1;
    else if (masked[index] === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return masked.length - 1;
}

function matchingBrace(masked, openOffset) {
  return matchingDelimiter(masked, openOffset, "{", "}");
}

function typeDeclarationModifiers(masked, declarationOffset) {
  let parentheses = 0;
  let brackets = 0;
  let declarationStart = 0;
  for (let index = declarationOffset - 1; index >= 0; index -= 1) {
    const character = masked[index];
    if (character === ")") parentheses += 1;
    else if (character === "(" && parentheses > 0) parentheses -= 1;
    else if (character === "]") brackets += 1;
    else if (character === "[" && brackets > 0) brackets -= 1;
    else if (parentheses === 0 && brackets === 0 && ";{}".includes(character)) {
      declarationStart = index + 1;
      break;
    }
  }

  const modifiers = new Set();
  let cursor = declarationStart;
  while (cursor < declarationOffset) {
    while (cursor < declarationOffset && /\s/u.test(masked[cursor])) cursor += 1;
    if (cursor >= declarationOffset) break;
    if (masked[cursor] === "@") {
      const annotation = masked.slice(cursor + 1, declarationOffset)
        .match(/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/u)?.[0];
      if (!annotation) return new Set();
      cursor += annotation.length + 1;
      while (cursor < declarationOffset && /\s/u.test(masked[cursor])) cursor += 1;
      if (masked[cursor] === "(") {
        const annotationEnd = matchingDelimiter(masked, cursor, "(", ")");
        if (annotationEnd >= declarationOffset) return new Set();
        cursor = annotationEnd + 1;
      }
      continue;
    }
    const modifier = masked.slice(cursor, declarationOffset)
      .match(/^(?:non-sealed|[A-Za-z_$][\w$]*)\b/u)?.[0];
    if (!modifier || !TYPE_DECLARATION_MODIFIERS.has(modifier)) return new Set();
    modifiers.add(modifier);
    cursor += modifier.length;
  }
  return modifiers;
}

function braceDepthsAt(masked, offsets) {
  const depths = new Map();
  const ordered = [...new Set(offsets)].sort((left, right) => left - right);
  let cursor = 0;
  let depth = 0;
  for (const offset of ordered) {
    while (cursor < offset) {
      if (masked[cursor] === "{") depth += 1;
      else if (masked[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    depths.set(offset, depth);
  }
  return depths;
}

function splitTopLevel(value) {
  if (!value) return [];
  const entries = [];
  let start = 0;
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "<") angleDepth += 1;
    else if (character === ">" && angleDepth > 0) angleDepth -= 1;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")" && parenthesisDepth > 0) parenthesisDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]" && bracketDepth > 0) bracketDepth -= 1;
    else if (character === "," && angleDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0) {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  entries.push(value.slice(start).trim());
  return entries.filter(Boolean);
}

function typeList(value) {
  return splitTopLevel(value).map((entry) => entry.replace(/<.*>/g, "")).filter(Boolean);
}

function normalizeParameterType(value) {
  return value
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*<\s*/g, "<")
    .replace(/\s*>\s*/g, ">")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*\[\s*]\s*/g, "[]")
    .replace(/\s*\.\.\.\s*/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function parameterDescriptors(value) {
  if (!value.trim()) return [];
  return splitTopLevel(value).flatMap((parameter) => {
    const cleaned = parameter
      .replace(/@[\w$.]+(?:\([^)]*\))?/g, " ")
      .replace(/\bfinal\b/g, " ")
      .trim();
    const nameMatch = cleaned.match(/([A-Za-z_$][\w$]*)\s*((?:\[\s*])*)$/);
    if (!nameMatch) return [];
    const type = normalizeParameterType(`${cleaned.slice(0, nameMatch.index).trim()}${nameMatch[2]}`);
    if (!type) return [];
    return [{ name: nameMatch[1], type }];
  });
}

function innermostEnclosingMethod(methods, offset) {
  return methods
    .filter((method) => offset >= method.bodyStart && offset <= method.bodyEnd)
    .sort((left, right) => (left.bodyEnd - left.bodyStart) - (right.bodyEnd - right.bodyStart))[0] ?? null;
}

function simpleReturnType(value) {
  return String(value ?? "")
    .replace(/<.*>/g, "")
    .replace(/\[\s*\]$/g, "")
    .trim()
    .split(".")
    .at(-1);
}

function isSwitchRuleArrow(masked, arrowOffset) {
  const boundary = Math.max(
    masked.lastIndexOf(";", arrowOffset - 1),
    masked.lastIndexOf("{", arrowOffset - 1),
    masked.lastIndexOf("}", arrowOffset - 1),
  );
  const candidate = masked.slice(boundary + 1, arrowOffset).trim();
  const keyword = candidate.match(/^(case|default)\b/u)?.[1];
  if (!keyword) return false;

  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let ternaryDepth = 0;
  for (let index = keyword.length; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (parentheses === 0 && brackets === 0 && braces === 0
      && character === "-" && candidate[index + 1] === ">") {
      return false;
    } else if (parentheses === 0 && brackets === 0 && braces === 0 && character === "?") {
      ternaryDepth += 1;
    } else if (parentheses === 0 && brackets === 0 && braces === 0 && character === ":") {
      if (candidate[index - 1] === ":" || candidate[index + 1] === ":") continue;
      if (ternaryDepth === 0) return false;
      ternaryDepth -= 1;
    }
    if (parentheses < 0 || brackets < 0 || braces < 0) return false;
  }
  return parentheses === 0 && brackets === 0 && braces === 0 && ternaryDepth === 0;
}

function skipWhitespace(masked, offset) {
  let cursor = offset;
  while (cursor < masked.length && /\s/u.test(masked[cursor])) cursor += 1;
  return cursor;
}

function identifierEnd(masked, offset) {
  return offset + (masked.slice(offset).match(/^[A-Za-z_$][\w$]*/u)?.[0].length ?? 0);
}

function typeAnnotationEnd(masked, offset) {
  let cursor = skipWhitespace(masked, offset + 1);
  let segmentEnd = identifierEnd(masked, cursor);
  if (segmentEnd === cursor) return -1;
  cursor = segmentEnd;
  while (true) {
    const dot = skipWhitespace(masked, cursor);
    if (masked[dot] !== ".") {
      cursor = dot;
      break;
    }
    cursor = skipWhitespace(masked, dot + 1);
    segmentEnd = identifierEnd(masked, cursor);
    if (segmentEnd === cursor) return -1;
    cursor = segmentEnd;
  }
  if (masked[cursor] !== "(") return cursor;
  const close = matchingDelimiter(masked, cursor, "(", ")");
  return masked[close] === ")" ? close + 1 : -1;
}

function typeArgumentsEnd(masked, offset) {
  let depth = 0;
  for (let cursor = offset; cursor < masked.length; cursor += 1) {
    if (masked[cursor] === "<") depth += 1;
    else if (masked[cursor] === ">") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    } else if (depth > 0 && ";{}".includes(masked[cursor])) {
      return -1;
    }
  }
  return -1;
}

function classInstanceCreationArgumentsStart(masked, newOffset) {
  if (masked.slice(newOffset, newOffset + 3) !== "new"
    || /[\w$]/u.test(masked[newOffset - 1] ?? "")
    || /[\w$]/u.test(masked[newOffset + 3] ?? "")) return -1;

  let cursor = skipWhitespace(masked, newOffset + 3);
  let expectIdentifier = true;
  let sawTypeName = false;
  while (cursor < masked.length) {
    cursor = skipWhitespace(masked, cursor);
    if (masked[cursor] === "@") {
      cursor = typeAnnotationEnd(masked, cursor);
      if (cursor === -1) return -1;
      continue;
    }
    if (expectIdentifier) {
      if (!sawTypeName && masked[cursor] === "<") {
        cursor = typeArgumentsEnd(masked, cursor);
        if (cursor === -1) return -1;
        continue;
      }
      const end = identifierEnd(masked, cursor);
      if (end === cursor) return -1;
      sawTypeName = true;
      expectIdentifier = false;
      cursor = end;
      continue;
    }
    if (masked[cursor] === "<") {
      cursor = typeArgumentsEnd(masked, cursor);
      if (cursor === -1) return -1;
      continue;
    }
    if (masked[cursor] === ".") {
      expectIdentifier = true;
      cursor += 1;
      continue;
    }
    return masked[cursor] === "(" && sawTypeName ? cursor : -1;
  }
  return -1;
}

function explicitGenericMethodArgumentsStart(masked, angleOffset) {
  if (masked[angleOffset] !== "<") return -1;
  let dot = angleOffset - 1;
  while (dot >= 0 && /\s/u.test(masked[dot])) dot -= 1;
  if (masked[dot] !== ".") return -1;
  let receiverEnd = dot - 1;
  while (receiverEnd >= 0 && /\s/u.test(masked[receiverEnd])) receiverEnd -= 1;
  if (!/[\w$)\]>]/u.test(masked[receiverEnd] ?? "")) return -1;

  let cursor = typeArgumentsEnd(masked, angleOffset);
  if (cursor === -1) return -1;
  cursor = skipWhitespace(masked, cursor);
  const methodEnd = identifierEnd(masked, cursor);
  if (methodEnd === cursor) return -1;
  cursor = skipWhitespace(masked, methodEnd);
  return masked[cursor] === "(" ? cursor : -1;
}

function lambdaBlockRanges(masked) {
  const ranges = [];
  for (const match of masked.matchAll(/->/g)) {
    const arrowOffset = match.index;
    if (isSwitchRuleArrow(masked, arrowOffset)) continue;
    let expressionStart = arrowOffset + match[0].length;
    while (expressionStart < masked.length && /\s/u.test(masked[expressionStart])) expressionStart += 1;
    if (masked[expressionStart] === "{") {
      ranges.push({ start: arrowOffset, end: matchingBrace(masked, expressionStart) });
      continue;
    }

    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    let expressionEnd = masked.length;
    for (let index = expressionStart; index < masked.length; index += 1) {
      const constructorArguments = classInstanceCreationArgumentsStart(masked, index);
      if (constructorArguments !== -1) {
        index = constructorArguments - 1;
        continue;
      }
      const genericMethodArguments = explicitGenericMethodArgumentsStart(masked, index);
      if (genericMethodArguments !== -1) {
        index = genericMethodArguments - 1;
        continue;
      }
      const character = masked[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0 && brackets === 0 && braces === 0) {
          expressionEnd = index;
          break;
        }
        parentheses -= 1;
      } else if (character === "[") brackets += 1;
      else if (character === "]") {
        if (brackets === 0 && parentheses === 0 && braces === 0) {
          expressionEnd = index;
          break;
        }
        brackets -= 1;
      } else if (character === "{") braces += 1;
      else if (character === "}") {
        if (braces === 0 && parentheses === 0 && brackets === 0) {
          expressionEnd = index;
          break;
        }
        braces -= 1;
      } else if ((character === "," || character === ";")
        && parentheses === 0 && brackets === 0 && braces === 0) {
        expressionEnd = index;
        break;
      }
    }
    ranges.push({ start: arrowOffset, end: expressionEnd });
  }
  return ranges;
}

function anonymousClassRanges(masked) {
  const ranges = [];
  for (const match of masked.matchAll(/\bnew\b/g)) {
    const argumentsStart = classInstanceCreationArgumentsStart(masked, match.index);
    if (argumentsStart === -1) continue;
    const argumentsEnd = matchingDelimiter(masked, argumentsStart, "(", ")");
    if (masked[argumentsEnd] !== ")") continue;
    let bodyStart = argumentsEnd + 1;
    while (bodyStart < masked.length && /\s/u.test(masked[bodyStart])) bodyStart += 1;
    if (masked[bodyStart] !== "{") continue;
    ranges.push({ start: bodyStart, end: matchingBrace(masked, bodyStart) });
  }
  return ranges;
}

function isInsideRange(ranges, offset) {
  return ranges.some((range) => offset > range.start && offset < range.end);
}

function owningType(types, offset) {
  return types
    .filter((type) => offset >= type.bodyStart && offset <= type.bodyEnd)
    .sort((left, right) => (left.bodyEnd - left.bodyStart) - (right.bodyEnd - right.bodyStart))[0] ?? null;
}

function factEnclosingMethod(methods, types, blockedRanges, offset) {
  if (isInsideRange(blockedRanges, offset)) return null;
  const method = innermostEnclosingMethod(methods, offset);
  if (!method?.ownerType) return null;
  return owningType(types, offset)?.fullName === method.ownerType ? method : null;
}

function isIbatisInvocation(source, offset, ownerType, fields) {
  const prefix = source.slice(Math.max(0, offset - 120), offset);
  if (/getSqlMap(?:Client|ClientTemplate)?\s*\(\s*\)\s*\.\s*$/i.test(prefix)) return true;
  const receiver = prefix.match(/([A-Za-z_$][\w$]*)\s*\.\s*$/)?.[1] ?? "";
  if (!receiver) return false;
  if (/sqlmap/i.test(receiver)) return true;
  const field = fields.find((candidate) => candidate.ownerType === ownerType && candidate.name === receiver);
  return /SqlMap(?:Client|Template)?/i.test(field?.type ?? "");
}

export function parseJava(content, filePath) {
  const locator = createEvidenceLocator(content, filePath, {
    recognizeBareCarriageReturns: true,
  });
  const translated = translateJavaUnicodeSource(content);
  const source = stripJavaCommentsWithEscapes(translated.source, NO_JAVA_UNICODE_ESCAPES);
  const masked = maskTranslatedJavaStrings(source);
  const rawOffsetAt = (offset) => translated.rawOffsets?.[offset] ?? offset;
  const evidenceAt = (offset, length = 0) => {
    const rawOffset = rawOffsetAt(offset);
    const rawEnd = rawOffsetAt(Math.min(offset + length, translated.source.length));
    return locator.at(rawOffset, rawEnd - rawOffset);
  };
  const packageName = masked.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1] ?? "";
  const imports = [...masked.matchAll(/\bimport\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$*][\w$*]*)*)\s*;/g)]
    .map((match) => match[1]);

  const types = [];
  const typePattern = /\b(class|interface|enum)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?(?:\s*<[^>{}]+>)?))?(?:\s+implements\s+([^\{]+))?\s*\{/g;
  const typeMatches = [...masked.matchAll(typePattern)];
  const typeBraceDepths = braceDepthsAt(masked, typeMatches.flatMap((match) => [
    match.index,
    match.index + match[0].lastIndexOf("{"),
  ]));
  for (const match of typeMatches) {
    const name = match[2];
    const bodyStart = match.index + match[0].lastIndexOf("{");
    const bodyEnd = matchingBrace(masked, bodyStart);
    const parent = owningType(types, match.index);
    const declarationDepth = typeBraceDepths.get(match.index);
    const directMember = parent
      && declarationDepth === typeBraceDepths.get(parent.bodyStart) + 1;
    const topLevel = !parent && declarationDepth === 0;
    const modifiers = typeDeclarationModifiers(masked, match.index);
    const staticMember = Boolean(
      directMember && (
        modifiers.has("static")
        || parent.kind === "interface"
        || match[1] === "interface"
        || match[1] === "enum"
      ),
    );
    const topLevelName = packageName ? `${packageName}.${name}` : name;
    const fullName = topLevel
      ? topLevelName
      : directMember
        ? `${parent.fullName}$${name}`
        : parent
          ? `${parent.fullName}$local$${name}$${rawOffsetAt(match.index)}`
          : `${topLevelName}$nested$${rawOffsetAt(match.index)}`;
    const canonicalName = topLevel
      ? topLevelName
      : directMember && parent.canonicalName
        ? `${parent.canonicalName}.${name}`
        : "";
    types.push({
      kind: match[1],
      name,
      fullName,
      ...(canonicalName ? { canonicalName } : {}),
      topLevel,
      staticMember,
      extendsType: (match[3] ?? "").replace(/\s*<.*>/g, ""),
      implementsTypes: typeList(match[4]),
      evidence: evidenceAt(match.index, match[0].length),
      bodyStart,
      bodyEnd,
    });
  }

  const fields = [];
  const fieldPattern = /^[ \t]*(?:public|protected|private)\s+(?:(?:static|final|volatile|transient)\s+)*([A-Za-z_$][\w$.]*(?:\s*<[A-Za-z_$][\w$.,? <>\[\]]*>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/gm;
  const fieldMatches = [...masked.matchAll(fieldPattern)];
  const fieldBraceDepths = braceDepthsAt(masked, [
    ...types.map((type) => type.bodyStart),
    ...fieldMatches.map((match) => match.index),
  ]);
  for (const match of fieldMatches) {
    const owner = owningType(types, match.index);
    if (!owner || fieldBraceDepths.get(match.index) !== fieldBraceDepths.get(owner.bodyStart) + 1) continue;
    fields.push({
      type: match[1].replace(/\s+/g, ""),
      name: match[2],
      ownerType: owner?.fullName ?? "",
      evidence: evidenceAt(match.index, match[0].length),
    });
  }

  const methods = [];
  const methodPattern = /^[ \t]*((?:(?:public|protected|private|static|final|synchronized|abstract|native|strictfp)\s+)*)([A-Za-z_$][\w$<>,.?\[\] \t]*?)\s+([A-Za-z_$][\w$]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:throws\s+[^\{;]+)?([\{;])/gm;
  const methodMatches = [...masked.matchAll(methodPattern)];
  const braceDepths = braceDepthsAt(masked, [
    ...types.map((type) => type.bodyStart),
    ...methodMatches.map((match) => match.index),
  ]);
  for (const match of methodMatches) {
    const returnTypeKeyword = match[2].trim().split(/\s+/u)[0];
    if (NON_TYPE_STATEMENT_KEYWORDS.has(returnTypeKeyword)) continue;
    const openOffset = match.index + match[0].lastIndexOf(match[5]);
    const bodyEnd = match[5] === "{" ? matchingBrace(masked, openOffset) : openOffset;
    const candidateOwner = owningType(types, match.index);
    const owner = candidateOwner
      && braceDepths.get(match.index) === braceDepths.get(candidateOwner.bodyStart) + 1
      ? candidateOwner
      : null;
    const descriptors = parameterDescriptors(match[4]);
    methods.push({
      name: match[3],
      visibility: match[1].match(/\b(public|protected|private)\b/u)?.[1] ?? "package",
      returnType: match[2],
      parameters: descriptors.map((parameter) => parameter.name),
      parameterTypes: descriptors.map((parameter) => parameter.type),
      methodSignature: descriptors.map((parameter) => parameter.type).join(","),
      bodyStart: openOffset,
      bodyEnd,
      ownerType: owner?.fullName ?? "",
      evidence: evidenceAt(match.index, match[0].length),
      returnedResults: [],
    });
  }

  const lambdaRanges = lambdaBlockRanges(masked);
  const anonymousRanges = anonymousClassRanges(masked);
  const blockedFactRanges = [...anonymousRanges, ...lambdaRanges];
  const returnedResultPatterns = [
    {
      kind: "struts1-find-forward",
      returnType: "ActionForward",
      pattern: /\breturn\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*findForward\s*\(\s*"([^"\\]*)"\s*\)\s*;/g,
    },
    {
      kind: "string-literal",
      returnType: "String",
      pattern: /\breturn\s*"([^"\\]*)"\s*;/g,
    },
  ];
  for (const resultPattern of returnedResultPatterns) {
    for (const match of source.matchAll(resultPattern.pattern)) {
      if (masked.slice(match.index, match.index + "return".length) !== "return") continue;
      const ownerMethod = factEnclosingMethod(methods, types, blockedFactRanges, match.index);
      if (!ownerMethod || simpleReturnType(ownerMethod.returnType) !== resultPattern.returnType) continue;
      ownerMethod.returnedResults.push({
        name: match[1],
        kind: resultPattern.kind,
        evidence: evidenceAt(match.index, match[0].length),
        offset: match.index,
      });
    }
  }
  for (const method of methods) {
    method.returnedResults = method.returnedResults
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...returnedResult }) => returnedResult);
  }

  const localVariables = [];
  const localVariablePattern = /\b(?:(?:final|volatile)\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;\n{}()]+>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?==|;|,)/g;
  for (const match of masked.matchAll(localVariablePattern)) {
    const type = match[1].replace(/\s+/g, "");
    if (NON_TYPE_STATEMENT_KEYWORDS.has(type)) continue;
    const ownerMethod = factEnclosingMethod(methods, types, blockedFactRanges, match.index);
    if (!ownerMethod) continue;
    localVariables.push({
      type,
      name: match[2],
      ownerType: ownerMethod.ownerType,
      enclosingMethod: ownerMethod.name,
      enclosingMethodArity: ownerMethod.parameters.length,
      enclosingMethodSignature: ownerMethod.methodSignature,
      evidence: evidenceAt(match.index, match[0].length),
      offset: match.index,
    });
  }

  const calls = [];
  const callPattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of masked.matchAll(callPattern)) {
    const ownerMethod = factEnclosingMethod(methods, types, blockedFactRanges, match.index);
    if (!ownerMethod) continue;
    calls.push({
      receiver: match[1],
      method: match[2],
      enclosingMethod: ownerMethod.name,
      enclosingMethodArity: ownerMethod.parameters.length,
      enclosingMethodSignature: ownerMethod.methodSignature,
      ownerType: ownerMethod.ownerType,
      evidence: evidenceAt(match.index, match[0].length),
      offset: match.index,
    });
  }
  const methodReturnCallPattern = /\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of masked.matchAll(methodReturnCallPattern)) {
    const ownerMethod = factEnclosingMethod(methods, types, blockedFactRanges, match.index);
    if (!ownerMethod) continue;
    const receiver = match[1].replace(/\s+/g, "");
    const receiverParts = receiver.split(".");
    const receiverMethod = receiverParts.at(-1);
    const implicitReceiver = receiverParts.length === 1 || receiverParts[0] === "this";
    if (!implicitReceiver) continue;
    calls.push({
      receiver: receiverMethod,
      receiverMethod,
      method: match[2],
      enclosingMethod: ownerMethod.name,
      enclosingMethodArity: ownerMethod.parameters.length,
      enclosingMethodSignature: ownerMethod.methodSignature,
      ownerType: ownerMethod.ownerType,
      evidence: evidenceAt(match.index, match[0].length),
      offset: match.index,
    });
  }

  const stringConstants = [];
  const stringConstantPattern = /\b(?:(?:public|protected|private)\s+)?(?:(?:static|final)\s+)*String\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"\s*;/g;
  const stringConstantMatches = [...source.matchAll(stringConstantPattern)];
  const stringConstantBraceDepths = braceDepthsAt(masked, [
    ...types.map((type) => type.bodyStart),
    ...stringConstantMatches.map((match) => match.index),
  ]);
  for (const match of stringConstantMatches) {
    if (masked[match.index] !== source[match.index]) continue;
    const owner = owningType(types, match.index);
    if (!owner
      || stringConstantBraceDepths.get(match.index) !== stringConstantBraceDepths.get(owner.bodyStart) + 1) continue;
    stringConstants.push({ name: match[1], value: match[2], ownerType: owner?.fullName ?? "" });
  }

  const statementUses = [];
  const statementPattern = /\b(queryForObject|queryForList|queryForMap|insert|update|delete)\s*\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/g;
  for (const match of source.matchAll(statementPattern)) {
    if (masked.slice(match.index, match.index + match[1].length) !== match[1]) continue;
    const ownerMethod = factEnclosingMethod(methods, types, blockedFactRanges, match.index);
    if (!ownerMethod || !isIbatisInvocation(source, match.index, ownerMethod.ownerType, fields)) continue;
    const literal = match[2] ?? "";
    const variable = match[3] ?? "";
    let candidates = [];
    if (literal) candidates = [{ value: literal, resolution: "literal", confidence: 1 }];
    else {
      const ownerConstants = stringConstants.filter((constant) => constant.ownerType === ownerMethod.ownerType);
      const exact = ownerConstants.find((constant) => constant.name === variable);
      if (exact) candidates = [{ value: exact.value, resolution: "class-constant", confidence: 0.95 }];
      else candidates = ownerConstants
        .filter((constant) => /statement|query|sql|mapper|id/i.test(constant.name))
        .map((constant) => ({ value: constant.value, resolution: "class-constant-candidate", confidence: 0.7 }));
    }
    for (const candidate of candidates) {
      statementUses.push({
        operation: match[1],
        statementId: candidate.value,
        resolution: candidate.resolution,
        confidence: candidate.confidence,
        enclosingMethod: ownerMethod.name,
        enclosingMethodArity: ownerMethod.parameters.length,
        enclosingMethodSignature: ownerMethod.methodSignature,
        ownerType: ownerMethod.ownerType,
        evidence: evidenceAt(match.index, match[0].length),
        offset: match.index,
      });
    }
  }

  return {
    packageName,
    imports,
    types: types.map(({ bodyStart, bodyEnd, ...type }) => ({
      ...type,
      bodyStart: rawOffsetAt(bodyStart),
      bodyEnd: rawOffsetAt(bodyEnd),
    })),
    fields,
    localVariables: localVariables
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...localVariable }) => localVariable),
    stringConstants,
    methods: methods.map(({ bodyStart, bodyEnd, ...method }) => ({
      ...method,
      bodyStart: rawOffsetAt(bodyStart),
      bodyEnd: rawOffsetAt(bodyEnd),
    })),
    calls: calls.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...call }) => call),
    statementUses: statementUses
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...statementUse }) => statementUse),
    warnings: [],
  };
}
