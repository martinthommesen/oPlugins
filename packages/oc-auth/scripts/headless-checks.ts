import { Effect, FileSystem, Schema } from "effect"
import type { PlatformError, Stdio } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import HeadlessSmokeError from "./headless-smoke-error.ts"
import commands from "./headless-command.ts"

/** The installed host, and how the smoke test runs it. */
interface Host {
  /** The variables that differ from the inherited environment. */
  readonly env: Readonly<Record<string, string>>
  readonly opencode: string
  readonly work: string
}

/** What the tool round trip reads and must return. */
interface RoundTrip {
  readonly model: string
  readonly sentinel: string
  readonly smoke: string
}

const ACCOUNT_LABEL = /Claude(?: (?:Pro|Max|Team|Enterprise|Code))?(?:\s|$)/mu,
  /** One model as the plugin wrapper lists it. */
  ModelPrice = Schema.Struct({
    cost: Schema.Array(Schema.Unknown),
    providerID: Schema.String,
  }),
  /** The model list the plugin wrapper writes. */
  ModelPrices = Schema.fromJsonString(Schema.Array(ModelPrice)),
  NO_PRICES = 0,
  URL_PATTERN = /https?:\/\//u,
  /* Fail with `message`. */
  failWith = (message: string): Effect.Effect<never, HeadlessSmokeError> =>
    Effect.fail(HeadlessSmokeError.make({ message })),
  /* Run the host with `args` in the sandbox. */
  hostRun = (
    host: Host,
    args: readonly string[],
  ): Effect.Effect<
    string,
    HeadlessSmokeError | PlatformError.PlatformError,
    ChildProcessSpawner.ChildProcessSpawner | Stdio.Stdio
  > =>
    commands.run({
      args,
      command: host.opencode,
      cwd: host.work,
      env: host.env,
    }),
  /* `auth list` shows the imported account under a Claude label. */
  labelShown = Effect.fn("Headless.accountLabel")(function* labelShown(
    host: Host,
  ) {
    const auth = yield* hostRun(host, ["auth", "list", "--standalone"]),
      shown = ACCOUNT_LABEL.test(auth)

    yield* commands
      .printError(auth)
      .pipe(
        Effect.andThen(failWith("Imported Claude account label was not shown")),
        Effect.when(Effect.succeed(!shown)),
      )
  }),
  /*
   * The host's Anthropic models keep their catalog prices. A custom model
   * has no catalog price, so only an all-zero catalog fails.
   */
  pricingKept = Effect.fn("Headless.nativePricing")(function* pricingKept(
    modelsPath: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      models = yield* Schema.decodeEffect(ModelPrices)(
        yield* fs.readFileString(modelsPath),
      ),
      subscription = models.filter((model) => model.providerID === "anthropic"),
      unpriced = subscription.every((model) => model.cost.length === NO_PRICES)

    yield* failWith(
      "Anthropic subscription models did not keep native pricing",
    ).pipe(Effect.when(Effect.succeed(unpriced)))
  }),
  /*
   * One read-tool round trip: the reply carries the sentinel, and the tool
   * call appears under its OpenCode name, never the wire alias.
   */
  roundTrip = Effect.fn("Headless.toolRoundTrip")(function* roundTrip(
    host: Host,
    trip: RoundTrip,
  ) {
    const output = yield* hostRun(host, [
        "run",
        "--standalone",
        "--auto",
        "--format",
        "json",
        "--model",
        trip.model,
        `Use the read tool to read ${trip.smoke}, then reply with exactly the file contents.`,
      ]),
      passed =
        output.includes(trip.sentinel) &&
        output.includes('"type":"tool_use"') &&
        output.includes('"tool":"read"') &&
        !output.includes('"tool":"mcp_')

    yield* commands
      .printError(output)
      .pipe(
        Effect.andThen(
          failWith(
            "Tool round trip did not return the sentinel under OpenCode names",
          ),
        ),
        Effect.when(Effect.succeed(!passed)),
      )
  }),
  /* The Claude Code method imports the account without a browser login. */
  silentImport = Effect.fn("Headless.autoImport")(function* silentImport(
    host: Host,
  ) {
    const login = yield* hostRun(host, [
        "auth",
        "login",
        "anthropic",
        "--method",
        "claude-code",
        "--standalone",
      ]),
      prompted = URL_PATTERN.test(login)

    yield* failWith("Auto import unexpectedly displayed a URL").pipe(
      Effect.when(Effect.succeed(prompted)),
    )
  })

/** The checks the smoke test runs against the installed host. */
export default Object.freeze({
  accountLabel: labelShown,
  autoImport: silentImport,
  nativePricing: pricingKept,
  toolRoundTrip: roundTrip,
})
