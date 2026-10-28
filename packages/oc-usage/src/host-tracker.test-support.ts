import { Brand, Context, Effect, Layer, Match, Ref } from "effect"
import type { Credential } from "@opencode/plugin/effect"
import FakeService from "./fake-service.test-support.ts"
import Host from "./host.ts"
import type { HttpClientRequest } from "effect/http"
import UsageMeter from "./usage-meter.ts"
import UsageTracker from "./usage-tracker.ts"
import claudeUsage from "./claude-usage.ts"
import codexUsage from "./codex-usage.ts"

interface Scripted {
  readonly codexGate: Ref.Ref<Effect.Effect<void>>
  readonly codexResolver: Ref.Ref<Effect.Effect<Credential.Value | undefined>>
  readonly failed: Ref.Ref<boolean>
  readonly gate: Ref.Ref<Effect.Effect<void>>
  readonly resolver: Ref.Ref<Effect.Effect<Credential.Value | undefined>>
}

const EXPIRES = Number.MAX_SAFE_INTEGER,
  FIRST_PERCENT = 10,
  FIVE_HOUR_SECONDS = 18_000,
  HTTP_UNAVAILABLE = 503,
  SECOND_PERCENT = 50,
  asMethod = Brand.nominal<Credential.OAuth["methodID"]>(),
  connectionHost = (scripted: Scripted): Layer.Layer<Host> =>
    Host.fromPlugin({
      integration: {
        connection: {
          active: (integrationId) =>
            Effect.succeed({
              id: integrationId,
              label: "Unchanged",
              method: "oauth",
              type: "credential",
            }),
          resolve: (connection: {
            readonly id?: string
            readonly type: string
          }) =>
            Match.value(connection.id).pipe(
              Match.when("openai", () => Ref.get(scripted.codexResolver)),
              Match.orElse(() => Ref.get(scripted.resolver)),
              Effect.flatMap((answer) => answer),
            ),
        },
      },
    }),
  oauth = (token: string, account = "account"): Credential.OAuth => ({
    access: token,
    expires: EXPIRES,
    metadata: { accountID: account },
    methodID: asMethod("oauth"),
    refresh: "synthetic-refresh",
    type: "oauth",
  }),
  response = (
    authorization: string | undefined,
    unavailable: boolean,
  ): Response => {
    const used = Match.value(authorization).pipe(
      Match.when("Bearer synthetic-a", () => FIRST_PERCENT),
      Match.orElse(() => SECOND_PERCENT),
    )

    if (unavailable) {
      return new Response("synthetic private response", {
        status: HTTP_UNAVAILABLE,
      })
    }

    return Response.json({
      five_hour: { utilization: used },
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          limit_window_seconds: FIVE_HOUR_SECONDS,
          used_percent: used,
        },
      },
      seven_day: { utilization: used },
    })
  },
  serve = (
    scripted: Scripted,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<Response> => {
    const awaiting = Match.value(request.url).pipe(
      Match.when(claudeUsage.url, () =>
        Ref.get(scripted.gate).pipe(Effect.flatMap((gate) => gate)),
      ),
      Match.orElse(() =>
        Ref.get(scripted.codexGate).pipe(Effect.flatMap((gate) => gate)),
      ),
    )

    return awaiting.pipe(
      Effect.andThen(Ref.get(scripted.failed)),
      Effect.map((failed) =>
        response(request.headers["authorization"], failed),
      ),
    )
  }

/** Mutable host state behind the production Host, tracker and HTTP meter. */
class HostScript extends Context.Service<HostScript, Scripted>()(
  "@martinthommesen/oc-usage/host-tracker.test-support/HostScript",
) {
  public static readonly layer = Layer.effectContext(
    Effect.gen(function* build() {
      const grant = Effect.succeed(oauth("synthetic-a")),
        scripted = yield* Effect.all({
          codexGate: Ref.make(Effect.void),
          codexResolver:
            Ref.make<Effect.Effect<Credential.Value | undefined>>(grant),
          failed: Ref.make(false),
          gate: Ref.make(Effect.void),
          resolver:
            Ref.make<Effect.Effect<Credential.Value | undefined>>(grant),
        }),
        transport = FakeService.layer((request) => serve(scripted, request)),
        usage = UsageMeter.layer.pipe(Layer.provide(transport)),
        watched = UsageTracker.layer([claudeUsage, codexUsage]).pipe(
          Layer.provide([connectionHost(scripted), usage]),
        ),
        wired = yield* Layer.build(watched)

      return Context.add(wired, HostScript, scripted)
    }),
  )

  public static readonly oauth = oauth
}

export default HostScript
