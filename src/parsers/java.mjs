import { createEvidenceLocator } from "../evidence.mjs";

function blankCharacter(character) {
  return character === "\n" || character === "\r" ? character : " ";
}

export function stripJavaComments(content) {
  let output = "";
  let state = "code";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line-comment";
      } else if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block-comment";
      } else {
        output += character;
        if (character === '"') state = "string";
        else if (character === "'") state = "character";
      }
    } else if (state === "line-comment") {
      output += blankCharacter(character);
      if (character === "\n") state = "code";
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += blankCharacter(character);
      }
    } else {
      output += character;
      if (character === "\\" && next !== undefined) {
        output += next;
        index += 1;
      } else if ((state === "string" && character === '"') || (state === "character" && character === "'")) {
        state = "code";
      }
    }
  }
  return output;
}

function maskJavaStrings(content) {
  let output = "";
  let quote = "";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (!quote) {
      if (character === '"' || character === "'") {
        quote = character;
        output += " ";
      } else {
        output += character;
      }
    } else if (character === "\\" && content[index + 1] !== undefined) {
      output += "  ";
      index += 1;
    } else if (character === quote) {
      output += " ";
      quote = "";
    } else {
      output += blankCharacter(character);
    }
  }
  return output;
}

function matchingBrace(masked, openOffset) {
  let depth = 0;
  for (let index = openOffset; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return masked.length - 1;
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

function enclosingMethod(methods, offset) {
  return methods.find((method) => offset >= method.bodyStart && offset <= method.bodyEnd) ?? null;
}

function owningType(types, offset) {
  return types
    .filter((type) => offset >= type.bodyStart && offset <= type.bodyEnd)
    .sort((left, right) => (left.bodyEnd - left.bodyStart) - (right.bodyEnd - right.bodyStart))[0] ?? null;
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
  const locator = createEvidenceLocator(content, filePath);
  const source = stripJavaComments(content);
  const masked = maskJavaStrings(source);
  const packageName = source.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1] ?? "";
  const imports = [...source.matchAll(/\bimport\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$*][\w$*]*)*)\s*;/g)]
    .map((match) => match[1]);

  const types = [];
  const typePattern = /\b(class|interface|enum)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?(?:\s*<[^>{}]+>)?))?(?:\s+implements\s+([^\{]+))?\s*\{/g;
  for (const match of source.matchAll(typePattern)) {
    const name = match[2];
    const bodyStart = match.index + match[0].lastIndexOf("{");
    const bodyEnd = matchingBrace(masked, bodyStart);
    types.push({
      kind: match[1],
      name,
      fullName: packageName ? `${packageName}.${name}` : name,
      extendsType: (match[3] ?? "").replace(/\s*<.*>/g, ""),
      implementsTypes: typeList(match[4]),
      evidence: locator.at(match.index, match[0].length),
      bodyStart,
      bodyEnd,
    });
  }

  const fields = [];
  const fieldPattern = /^[ \t]*(?:public|protected|private)\s+(?:(?:static|final|volatile|transient)\s+)*([A-Za-z_$][\w$.]*(?:\s*<[A-Za-z_$][\w$.,? <>\[\]]*>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/gm;
  for (const match of source.matchAll(fieldPattern)) {
    const owner = owningType(types, match.index);
    fields.push({
      type: match[1].replace(/\s+/g, ""),
      name: match[2],
      ownerType: owner?.fullName ?? "",
      evidence: locator.at(match.index, match[0].length),
    });
  }

  const methods = [];
  const methodPattern = /^[ \t]*(?:(?:public|protected|private|static|final|synchronized|abstract|native|strictfp)\s+)*([A-Za-z_$][\w$<>,.?\[\] \t]*?)\s+([A-Za-z_$][\w$]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:throws\s+[^\{;]+)?([\{;])/gm;
  for (const match of source.matchAll(methodPattern)) {
    const openOffset = match.index + match[0].lastIndexOf(match[4]);
    const bodyEnd = match[4] === "{" ? matchingBrace(masked, openOffset) : openOffset;
    const owner = owningType(types, match.index);
    const descriptors = parameterDescriptors(match[3]);
    methods.push({
      name: match[2],
      returnType: match[1],
      parameters: descriptors.map((parameter) => parameter.name),
      parameterTypes: descriptors.map((parameter) => parameter.type),
      methodSignature: descriptors.map((parameter) => parameter.type).join(","),
      bodyStart: openOffset,
      bodyEnd,
      ownerType: owner?.fullName ?? "",
      evidence: locator.at(match.index, match[0].length),
    });
  }

  const localVariables = [];
  const localVariablePattern = /\b(?:(?:final|volatile)\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;\n{}()]+>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?==|;|,)/g;
  for (const match of masked.matchAll(localVariablePattern)) {
    const ownerMethod = enclosingMethod(methods, match.index);
    if (!ownerMethod) continue;
    localVariables.push({
      type: match[1].replace(/\s+/g, ""),
      name: match[2],
      ownerType: ownerMethod.ownerType,
      enclosingMethod: ownerMethod.name,
      enclosingMethodArity: ownerMethod.parameters.length,
      enclosingMethodSignature: ownerMethod.methodSignature,
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  const calls = [];
  const callPattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of masked.matchAll(callPattern)) {
    const ownerMethod = enclosingMethod(methods, match.index);
    if (!ownerMethod) continue;
    calls.push({
      receiver: match[1],
      method: match[2],
      enclosingMethod: ownerMethod.name,
      enclosingMethodArity: ownerMethod.parameters.length,
      enclosingMethodSignature: ownerMethod.methodSignature,
      ownerType: ownerMethod.ownerType,
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }
  const methodReturnCallPattern = /\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of masked.matchAll(methodReturnCallPattern)) {
    const ownerMethod = enclosingMethod(methods, match.index);
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
      evidence: locator.at(match.index, match[0].length),
      offset: match.index,
    });
  }

  const stringConstants = [];
  const stringConstantPattern = /\b(?:(?:public|protected|private)\s+)?(?:(?:static|final)\s+)*String\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"\s*;/g;
  for (const match of source.matchAll(stringConstantPattern)) {
    const owner = owningType(types, match.index);
    stringConstants.push({ name: match[1], value: match[2], ownerType: owner?.fullName ?? "" });
  }

  const statementUses = [];
  const statementPattern = /\b(queryForObject|queryForList|queryForMap|insert|update|delete)\s*\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/g;
  for (const match of source.matchAll(statementPattern)) {
    const ownerMethod = enclosingMethod(methods, match.index);
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
        evidence: locator.at(match.index, match[0].length),
        offset: match.index,
      });
    }
  }

  return {
    packageName,
    imports,
    types,
    fields,
    localVariables: localVariables
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...localVariable }) => localVariable),
    stringConstants,
    methods: methods.map(({ bodyStart, bodyEnd, ...method }) => ({ ...method, bodyStart, bodyEnd })),
    calls: calls.sort((left, right) => left.offset - right.offset).map(({ offset: _offset, ...call }) => call),
    statementUses: statementUses
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset: _offset, ...statementUse }) => statementUse),
    warnings: [],
  };
}
