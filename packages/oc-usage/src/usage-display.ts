/* Service-provided names are displayed as one line, without terminal or bidi control characters. */
const label = (text: string): string =>
  text
    .replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()

export default Object.freeze({ label })
