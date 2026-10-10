import { Array as Arr, Predicate } from "effect"

/** A value a debug-log field may hold. */
type LogValue =
  | string
  | number
  | boolean
  | undefined
  | readonly LogValue[]
  | LogFields

/** The structured fields of one debug-log record. */
interface LogFields {
  readonly [key: string]: LogValue
}

type Scalar = Exclude<LogValue, object>

const ANTHROPIC_TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9]+-/u,
  JWT_PATTERN = /^eyJ[\w-]{10,}/u,
  MAX_DEPTH = 4,
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
  TOKEN_PREFIX_LENGTH = 8,
  guardList = (
    value: readonly LogValue[] | LogFields,
  ): value is readonly LogValue[] => Arr.isArray(value),
  guardNested = (value: LogValue): value is readonly LogValue[] | LogFields =>
    Predicate.isObjectOrArray(value),
  /* A token-shaped string keeps a short prefix, enough to tell tokens apart. */
  hideScalar = (value: Scalar): Scalar => {
    if (
      Predicate.isString(value) &&
      (JWT_PATTERN.test(value) || ANTHROPIC_TOKEN_PATTERN.test(value))
    ) {
      return `${value.slice(ROOT_DEPTH, TOKEN_PREFIX_LENGTH)}...REDACTED`
    }

    return value
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
