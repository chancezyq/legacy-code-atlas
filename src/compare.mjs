// Shared sort comparators. The two orderings are deliberately distinct:
// compareText is code-point order (used for deterministic, language-neutral
// keys and file paths), while compareLocale is English locale order (used
// for user-facing search and traversal ordering). Do not merge them: several
// determinism tests pin the exact order each one produces.
export function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareLocale(left, right) {
  return String(left).localeCompare(String(right), "en");
}
