import { Deferred, Effect, Layer } from "effect"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import type { Plugin } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import UsageRpc from "./usage-rpc.ts"
import rpcHandlers from "./rpc-handlers.ts"
import services from "./services.ts"

type ServicesHost = Parameters<typeof services.layer>[typeof FIRST]

/** The parts of the host's plugin context this plugin uses. */
interface PluginHost extends ServicesHost {
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
}

const FIRST = 0,
  /*
   * Registers the RPC with `handlers`. A failure is a defect, which the host
   * reports as a failed plugin.
   */
  attachRpc = (
    rpc: PluginHost["rpc"],
    handlers: RpcHandlers<typeof UsageRpc>,
  ): Effect.Effect<RpcRegistration<typeof UsageRpc>, never, Scope.Scope> => {
    // The host's call fails with `unknown`, which becomes a defect here.
    const registering: Effect.Effect<
      RpcRegistration<typeof UsageRpc>,
      never,
      Scope.Scope
    > = rpc.register(UsageRpc, handlers).pipe(Effect.orDie)

    return registering
  },
  /* Builds the services into the plugin's scope, and registers the RPC the CLI plugin calls. */
  install = Effect.fn("UsagePlugin.install")(function* install(
    context: PluginHost,
  ) {
    const built = yield* Layer.build(services.layer(context)),
      registered = yield* Deferred.make<RpcRegistration<typeof UsageRpc>>(),
      registration = yield* attachRpc(
        context.rpc,
        rpcHandlers.handlersOf(built, registered),
      )

    yield* Deferred.succeed(registered, registration)
  }),
  /*
   * Measures the Claude and ChatGPT subscriptions' usage for the CLI plugin.
   * An invalid option is a defect, which the host reports as a failed
   * plugin.
   *
   * Every import from the host SDK is a type, so the SDK stays out of
   * consumers' installs.
   */
  plugin = {
    effect: (context: PluginHost): Effect.Effect<void, never, Scope.Scope> =>
      install(context).pipe(Effect.orDie),
    id: "martinthommesen.oc-usage",
  } satisfies Plugin.Plugin

export default plugin
