const UNSAFE_TEXT_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu;
// Printable ASCII contains no Cc/Cf/Cs/Zl/Zp code points, so a string matching
// this cheap class can skip the slower Unicode-property scans entirely.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function containsUnsafeTextControl(value) {
  const text = String(value ?? "");
  return !PRINTABLE_ASCII.test(text) && UNSAFE_TEXT_CONTROL.test(text);
}

export function replaceUnsafeTextControls(value, replacement = " ") {
  const text = String(value ?? "");
  return PRINTABLE_ASCII.test(text) ? text : text.replace(UNSAFE_TEXT_CONTROLS, replacement);
}
