import type { Config, Option } from "effect"
import { ConfigProvider, Effect, Encoding, HashMap, Layer } from "effect"
import type { HostInterface, SessionId, SessionSnapshot } from "./host.ts"
import type { Credential } from "@opencode/plugin/effect"
import { Host } from "./host.ts"
import { HostError } from "./errors/host-error.ts"
import { Integration } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Settings } from "./settings.ts"

/** Plugin options as a test passes them. */
type Options = Readonly<Record<string, string>>

/** JWT claims as a test passes them. */
type Claims = Readonly<
  Record<string, Readonly<Record<string, string>> | string>
>

const HOUR_MILLIS = 3_600_000

/**
 * Settings decoded from plugin options, as the plugin reads them.
 * @param {Options} options Plugin options.
 * @returns {Layer.Layer<Settings, Config.ConfigError>} A `Settings` layer.
 */
const settingsFrom = (
  options: Options,
): Layer.Layer<Settings, Config.ConfigError> => {
  const provider = ConfigProvider.layer(ConfigProvider.fromUnknown(options))

  return Settings.layer.pipe(Layer.provide(provider))
}

/**
 * A session id for tests.
 * @param {string} id The id text.
 * @returns {SessionId} The branded id.
 */
const sessionId = (id: string): SessionId => Session.ID.make(id)

/**
 * Builds an unsigned JWT whose payload carries the given claims.
 * @param {Claims} claims The payload claims.
 * @returns {string} The token.
 */
const jwt = (claims: Claims): string => {
  const header = Encoding.encodeBase64Url(JSON.stringify({ alg: "none" }))
  const payload = Encoding.encodeBase64Url(JSON.stringify(claims))

  return [header, payload, "signature"].join(".")
}

/**
 * An OpenAI OAuth credential like OpenCode's ChatGPT sign-in stores. It
 * expires an hour after the test clock's start.
 * @param {string} access The access token.
 * @returns {Credential.OAuth} The credential.
 */
const oauthCredential = (access: string): Credential.OAuth => ({
  access,
  expires: HOUR_MILLIS,
  methodID: Integration.MethodID.make("chatgpt-token-sharing"),
  refresh: "refresh-token",
  type: "oauth",
})

/**
 * A `Host` serving fixed sessions and an optional OpenAI credential.
 * @param {Option.Option<Credential.Key | Credential.OAuth>} credential The
 * OpenAI credential.
 * @param {HashMap.HashMap<string, SessionSnapshot>} sessions Sessions by id.
 * @returns {Layer.Layer<Host>} A layer providing `Host`.
 */
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
