export function normalizePath(filePath) {
  return String(filePath).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function createEvidence(file, line, column = 1, snippet = "") {
  if (!Number.isInteger(line) || line < 1) throw new TypeError("evidence line must be a positive integer");
  if (!Number.isInteger(column) || column < 1) throw new TypeError("evidence column must be a positive integer");
  return {
    file: normalizePath(file),
    line,
    column,
    snippet: String(snippet).trim(),
  };
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createEvidenceLocator(content, filePath) {
  const normalizedFilePath = normalizePath(filePath);
  const newlineOffsets = [];
  for (let offset = content.indexOf("\n"); offset !== -1; offset = content.indexOf("\n", offset + 1)) {
    newlineOffsets.push(offset);
  }

  return {
    assertSource(candidateContent, candidateFilePath) {
      if (candidateContent !== content || normalizePath(candidateFilePath) !== normalizedFilePath) {
        throw new TypeError("evidence locator is bound to a different source or file");
      }
    },
    at(offset, _length = 0) {
      const nextNewlineIndex = lowerBound(newlineOffsets, offset);
      const lastNewline = nextNewlineIndex === 0 ? -1 : newlineOffsets[nextNewlineIndex - 1];
      const nextNewline = newlineOffsets[nextNewlineIndex] ?? content.length;
      return createEvidence(
        normalizedFilePath,
        nextNewlineIndex + 1,
        offset - lastNewline,
        content.slice(lastNewline + 1, nextNewline),
      );
    },
    offsetAt(line, column = 1) {
      if (!Number.isInteger(line) || line < 1) throw new TypeError("evidence line must be a positive integer");
      if (!Number.isInteger(column) || column < 1) throw new TypeError("evidence column must be a positive integer");
      if (line > newlineOffsets.length + 1) throw new RangeError("evidence line is outside the source");
      const lineStart = line === 1 ? 0 : newlineOffsets[line - 2] + 1;
      const lineEnd = newlineOffsets[line - 1] ?? content.length;
      if (column > lineEnd - lineStart + 1) throw new RangeError("evidence column is outside the source line");
      return lineStart + column - 1;
    },
  };
}

export function evidenceAt(content, file, offset, length = 0) {
  return createEvidenceLocator(content, file).at(offset, length);
}
