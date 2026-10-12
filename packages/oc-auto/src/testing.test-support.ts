import { Effect, HashMap, Layer } from "effect"
import { Base64Url } from "effect/encoding"
import type { Credential } from "@opencode/plugin/effect"
import Host from "./host.ts"
import HostError from "./host-error.ts"
import { Integration } from "@opencode/plugin/effect"
import type { Option } from "effect"
import { Session } from "@opencode/schema/session"

type SessionId = Parameters<Host["Service"]["session"]>[typeof FIRST]

type SessionSnapshot = Effect.Success<ReturnType<Host["Service"]["session"]>>

type Claims = Readonly<
  Record<string, Readonly<Record<string, string>> | string>
>

const FIRST = 0,
  HOUR_MILLIS = 3_600_000,
  /* A host with `credential` connected and `sessions` to read. */
  fakeHost = (
    credential: Option.Option<Credential.Key | Credential.OAuth>,
    sessions: HashMap.HashMap<string, SessionSnapshot>,
  ): Layer.Layer<Host> => {
    const service: Host["Service"] = {
      openAiCredential: Effect.succeed(credential),
      session: Effect.fn("FakeHost.session")(function* session(id: SessionId) {
        return yield* Effect.fromOption(HashMap.get(sessions, id)).pipe(
          Effect.mapError(() =>
            HostError.make({
              category: "not_found",
              cause: id,
              operation: "session.get",
            }),
          ),
        )
      }),
    }

    return Layer.succeed(Host, Host.of(service))
  },
  /* An unsigned JWT carrying `claims`. */
  jwt = (claims: Claims): string => {
    const header = Base64Url.encode(JSON.stringify({ alg: "none" })),
      payload = Base64Url.encode(JSON.stringify(claims))

    return [header, payload, "signature"].join(".")
  },
  /* A ChatGPT sign-in with the access token `access`, which expires an hour after the test clock's start. */
  oauthCredential = (access: string): Credential.OAuth => ({
    access,
    expires: HOUR_MILLIS,
    methodID: Integration.MethodID.make("chatgpt-token-sharing"),
    refresh: "refresh-token",
    type: "oauth",
  }),
  sessionId = (id: string): SessionId => Session.ID.make(id)

/** Fakes and fixtures the tests share. */
export default Object.freeze({
  fakeHost,
  jwt,
  oauthCredential,
  sessionId,
})
