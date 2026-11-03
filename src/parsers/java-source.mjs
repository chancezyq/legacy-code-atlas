// Java source preprocessing: Unicode escapes, comment stripping, and
// string/text-block masking, plus delimiter matching over the masked
// source. Moved out of the Java parser so that file can shrink; the only
// consumer is parseJava (and stripJavaComments, which tests use directly).

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

export function translateJavaUnicodeSource(content) {
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

export function stripJavaCommentsWithEscapes(content, unicodeEscapes) {
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

export const NO_JAVA_UNICODE_ESCAPES = new Map();

export function maskTranslatedJavaStrings(content) {
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

export function matchingDelimiter(masked, openOffset, openCharacter, closeCharacter) {
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

export function matchingBrace(masked, openOffset) {
  return matchingDelimiter(masked, openOffset, "{", "}");
}
