import type { Config, Option } from "effect"
import { ConfigProvider, Effect, Encoding, HashMap, Layer } from "effect"
import type { HostInterface, SessionId, SessionSnapshot } from "./host.ts"
import type { Credential } from "@opencode/plugin/effect"
import { Host } from "./host.ts"
import { HostError } from "./errors/host-error.ts"
import { Integration } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Settings } from "./settings.ts"

type Options = Readonly<Record<string, string>>

type Claims = Readonly<
  Record<string, Readonly<Record<string, string>> | string>
>

const HOUR_MILLIS = 3_600_000

const settingsFrom = (
  options: Options,
): Layer.Layer<Settings, Config.ConfigError> => {
  const provider = ConfigProvider.layer(ConfigProvider.fromUnknown(options))

  return Settings.layer.pipe(Layer.provide(provider))
}

const sessionId = (id: string): SessionId => Session.ID.make(id)

const jwt = (claims: Claims): string => {
  const header = Encoding.encodeBase64Url(JSON.stringify({ alg: "none" }))
  const payload = Encoding.encodeBase64Url(JSON.stringify(claims))

  return [header, payload, "signature"].join(".")
}

// Expires an hour after the test clock's start.
const oauthCredential = (access: string): Credential.OAuth => ({
  access,
  expires: HOUR_MILLIS,
  methodID: Integration.MethodID.make("chatgpt-token-sharing"),
  refresh: "refresh-token",
  type: "oauth",
})

const fakeHost = (
  credential: Option.Option<Credential.Key | Credential.OAuth>,
  sessions: HashMap.HashMap<string, SessionSnapshot>,
): Layer.Layer<Host> => {
  const service: HostInterface = {
    openAiCredential: Effect.succeed(credential),
    session: Effect.fn("FakeHost.session")(function* session(id: SessionId) {
      return yield* Effect.fromOption(HashMap.get(sessions, id)).pipe(
        Effect.mapError(
          () => new HostError({ cause: id, operation: "session.get" }),
        ),
      )
    }),
  }

  return Layer.succeed(Host, Host.of(service))
}

export { fakeHost, jwt, oauthCredential, sessionId, settingsFrom }
