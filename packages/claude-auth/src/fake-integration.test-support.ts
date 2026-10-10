import { Array as Arr, Context, Effect, Layer, Option } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import type claudeAuth from "./claude-auth-plugin.ts"

type Host = Parameters<typeof claudeAuth.setUp>[typeof FIRST]

const FIRST = 0,
  /** What registering a transform hands back; disposal is the scope's job. */
  REGISTRATION = Object.freeze({ dispose: Effect.void })

/** The host's integration API, recording the `/connect` method registered. */
class FakeIntegration extends Context.Service<
  FakeIntegration,
  {
    /** The method registered last; a test that expects none dies. */
    readonly method: Effect.Effect<IntegrationOAuthMethodRegistration>
    /** The integration transform the plugin is given. */
    readonly transform: Host["integration"]["transform"]
  }
>()("oclaude/fake-integration.test-support/FakeIntegration") {
  /** An integration API for one test. */
  public static readonly layer: Layer.Layer<FakeIntegration> = Layer.sync(
    FakeIntegration,
    () => {
      const registered: IntegrationOAuthMethodRegistration[] = []

      return FakeIntegration.of({
        method: Effect.suspend(() =>
          Option.match(Arr.last(registered), {
            onNone: () => Effect.die("no /connect method was registered"),
            onSome: (registration) => Effect.succeed(registration),
          }),
        ),
        transform: (edit) =>
          Effect.sync(() => {
            edit({
              method: {
                update: (registration) => {
                  registered.push(registration)
                },
              },
            })

            return REGISTRATION
          }),
      })
    },
  )
}

export default FakeIntegration
