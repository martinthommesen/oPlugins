import { Schema } from "effect"

/*
 * The usage report the server plugin sends the CLI plugin. A value a
 * service didn't report is none, which the RPC carries as `null`.
 */

/** The subscription isn't connected in OpenCode. */
const Disconnected = Schema.TaggedStruct("Disconnected", {
    /** What to do to connect it. */
    hint: Schema.String,
  }),
  /** Oc-usage has no measurement of the subscription, and says why. */
  Failed = Schema.TaggedStruct("Failed", { problem: Schema.String }),
  /** The connection can't report subscription usage, such as an API key. */
  Ineligible = Schema.TaggedStruct("Ineligible", { reason: Schema.String }),
  /** One usage limit window of a subscription. */
  LimitWindow = Schema.Struct({
    /** What the window covers, such as `5-hour` or `Weekly Opus`. */
    label: Schema.String,
    /** When the window resets, in epoch milliseconds. */
    resetsAt: Schema.OptionFromNullOr(Schema.Finite),
    /** The share of the window's limit used, in percent. */
    usedPercent: Schema.OptionFromNullOr(Schema.Finite),
  }),
  /**
   * The newest measurement of the subscription. A problem means the newest
   * attempt failed, and the measurement is from an earlier one.
   */
  Measured = Schema.TaggedStruct("Measured", {
    /** When oc-usage took the measurement, in epoch milliseconds. */
    measuredAt: Schema.Finite,
    /** The subscription's plan, such as `Plus`. */
    plan: Schema.OptionFromNullOr(Schema.String),
    problem: Schema.OptionFromNullOr(Schema.String),
    windows: Schema.Array(LimitWindow),
  }),
  /** What oc-usage knows about one subscription's usage. */
  State = Schema.Union([Disconnected, Failed, Ineligible, Measured]),
  /** One subscription and its usage. */
  Subscription = Schema.Struct({
    state: State,
    /** The subscription's name, such as `Claude`. */
    title: Schema.String,
  }),
  /** Every subscription oc-usage measures, in a fixed order. */
  UsageReport = Schema.Struct({ subscriptions: Schema.Array(Subscription) })

/** The usage report, as the server plugin sends it to the CLI plugin. */
export default Object.freeze({
  Disconnected,
  Failed,
  Ineligible,
  LimitWindow,
  Measured,
  State,
  Subscription,
  UsageReport,
})
