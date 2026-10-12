import { Array as Arr, Predicate, String as Str } from "effect"

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

const LEADING_JWT = /^eyJ[\w-]{10,}/u,
  MAX_DEPTH = 4,
  NESTED = "[nested]",
  NEXT_LEVEL = 1,
  REDACTED = "REDACTED",
  REDACTED_KEYS = new Set([
    "access",
    "accessToken",
    "account",
    "authorization",
    "cookie",
    "password",
    "refresh",
    "refreshToken",
    "set-cookie",
    "token",
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
  /* `token` cut to a short prefix, enough to tell tokens apart. */
  hidden = (token: string): string =>
    `${Str.takeLeft(token, TOKEN_PREFIX_LENGTH)}...REDACTED`,
  /*
   * `value` with every recognized token in it cut to its prefix. A string
   * that starts with a JWT is cut whole, because `TOKEN_PATTERN` stops at a
   * standard base64 character (`+`, `/`, `=`) that could continue the
   * secret.
   */
  hideScalar = (value: Scalar): Scalar => {
    if (!Predicate.isString(value)) {
      return value
    }

    if (LEADING_JWT.test(value)) {
      return hidden(value)
    }

    return value.replaceAll(TOKEN_PATTERN, (token) => hidden(token))
  },
  /*
   * `value` with known secrets hidden. A field whose name is in
   * `REDACTED_KEYS`, matched exactly, case included, is replaced whole. Past
   * `MAX_DEPTH` a structure is dropped rather than passed through, because
   * an unvisited object could hold a key that should be redacted.
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
      Object.entries(value).map(
        ([name, field]: readonly [string, LogValue]) => [
          name,
          hideValue(name, field, depth + NEXT_LEVEL),
        ],
      ),
    )
  },
  /*
   * `fields` with known secret fields and recognized tokens hidden, at any
   * depth up to the limit. Other sensitive content passes through.
   */
  redact = (fields: LogFields): LogFields =>
    Object.fromEntries(
      Object.entries(fields).map(
        ([name, field]: readonly [string, LogValue]) => [
          name,
          hideValue(name, field, ROOT_DEPTH),
        ],
      ),
    )

/** A log record's fields with known secrets hidden. */
export default redact
