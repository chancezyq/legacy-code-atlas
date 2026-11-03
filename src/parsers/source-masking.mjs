// Pure source-range masking utilities: blank out (or keep only) byte
// ranges while preserving line/column offsets. Shared by the JSP scanner
// and the JavaScript-request extractor, which both need to hide inert
// source regions without shifting offsets.

export function blankRegion(value) {
  return value.replace(/[^\n\r]/g, " ");
}

export function maskedSource(content, ranges) {
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

export function sourceWithinRanges(content, ranges) {
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
