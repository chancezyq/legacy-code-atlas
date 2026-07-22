const UNSAFE_TEXT_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu;

export function containsUnsafeTextControl(value) {
  return UNSAFE_TEXT_CONTROL.test(String(value ?? ""));
}

export function replaceUnsafeTextControls(value, replacement = " ") {
  return String(value ?? "").replace(UNSAFE_TEXT_CONTROLS, replacement);
}
