import { Array as Arr, Predicate } from "effect"

/** A value a log record field may hold. */
type LogValue =
  | string
  | number
  | boolean
  | undefined
  | readonly LogValue[]
  | LogFields

/** The structured fields of one log record. */
interface LogFields {
  readonly [key: string]: LogValue
}

type Scalar = Exclude<LogValue, object>

const MAX_DEPTH = 4,
  NESTED = "[nested]",
  NEXT_LEVEL = 1,
  REDACTED = "REDACTED",
  REDACTED_KEYS = new Set([
    "access",
    "accessToken",
    "account",
    "refresh",
    "refreshToken",
    "x-api-key",
  ]),
  ROOT_DEPTH = 0,
  /*
   * An Anthropic token (`sk-ant-...`) or a JWT, wherever it appears in a
   * string: an error message can quote one.
   */
  TOKEN_PATTERN = /(?<![\w-])(?:sk-ant-[A-Za-z0-9]+-|eyJ[\w-]{10,})[\w.-]*/gu,
  TOKEN_PREFIX_LENGTH = 8,
  guardList = (
    value: readonly LogValue[] | LogFields,
  ): value is readonly LogValue[] => Arr.isArray(value),
  guardNested = (value: LogValue): value is readonly LogValue[] | LogFields =>
    Predicate.isObjectOrArray(value),
  /*
   * Each token in a string keeps a short prefix, enough to tell tokens
   * apart, and loses the rest.
   */
  hideScalar = (value: Scalar): Scalar => {
    if (!Predicate.isString(value)) {
      return value
    }

    return value.replaceAll(
      TOKEN_PATTERN,
      (token) => `${token.slice(ROOT_DEPTH, TOKEN_PREFIX_LENGTH)}...REDACTED`,
    )
  },
  /*
   * `value` with secrets removed. A field named like a secret is replaced
   * outright. Past `MAX_DEPTH` a structure is dropped rather than passed
   * through, because an unvisited object could hold a key that should be
   * redacted.
   */
  hideValue = (key: string, value: LogValue, depth: number): LogValue => {
    if (REDACTED_KEYS.has(key)) {
      return REDACTED
    }

    if (!guardNested(value)) {
      return hideScalar(value)
    }

    if (depth >= MAX_DEPTH) {
      return NESTED
    }

    if (guardList(value)) {
      return value.map((item) => hideValue("", item, depth + NEXT_LEVEL))
    }

    return Object.fromEntries(
      Object.entries(value).map((entry: readonly [string, LogValue]) => [
        entry[ROOT_DEPTH],
        hideValue(entry[ROOT_DEPTH], entry[NEXT_LEVEL], depth + NEXT_LEVEL),
      ]),
    )
  },
  /* `fields` with every secret removed, at any depth up to the limit. */
  redact = (fields: LogFields): LogFields =>
    Object.fromEntries(
      Object.entries(fields).map((entry: readonly [string, LogValue]) => [
        entry[ROOT_DEPTH],
        hideValue(entry[ROOT_DEPTH], entry[NEXT_LEVEL], ROOT_DEPTH),
      ]),
    )

export default redact
