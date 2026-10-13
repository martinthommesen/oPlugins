import { Context, Deferred, Effect, Schema } from "effect"
import HostError from "./host-error.ts"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import SidebarSetting from "./sidebar-setting.ts"
import type UsageRpc from "./usage-rpc.ts"
import UsageTracker from "./usage-tracker.ts"
import usageReport from "./usage-report.ts"

type Registration = RpcRegistration<typeof UsageRpc>

/** Whether the sidebar shows the usage section, as the RPC carries it. */
interface Sidebar {
  readonly shown: boolean
}

/** The RPC's methods. None reads the call's context, so none takes it. */
interface Handlers {
  /** Every subscription's usage, in its JSON form. */
  readonly report: () => Effect.Effect<typeof usageReport.UsageReport.Encoded>
  /** Saves the sidebar setting, and tells every CLI. */
  readonly setSidebar: (input: Sidebar) => Effect.Effect<Sidebar>
  /** The sidebar setting. */
  readonly sidebar: () => Effect.Effect<Sidebar>
}

/*
 * Tells every CLI that the sidebar setting changed, once the RPC that
 * carries the news is registered. A CLI that misses it reads the setting
 * when it starts.
 */
const announce = Effect.fn("UsageRpc.announce")(function* announce(
    registered: Deferred.Deferred<Registration>,
    shown: boolean,
  ) {
    const registration = yield* Deferred.await(registered),
      // The host's call fails with `unknown`, mapped to a `HostError` naming the call.
      sent: Effect.Effect<void, HostError> = registration.events
        .emit("sidebarChanged", { shown })
        .pipe(HostError.during("rpc.events.emit"))

    yield* sent.pipe(
      Effect.catchTag("HostError", (failure: { readonly category: string }) =>
        Effect.logWarning("sidebar_change_unannounced").pipe(
          Effect.annotateLogs({ category: failure.category }),
        ),
      ),
    )
  }),
  encodeReport = Schema.encodeEffect(usageReport.UsageReport),
  /*
   * The RPC's methods over the plugin's services. The sidebar setting's
   * change goes out through `registered`, the RPC's registration.
   */
  handlersOf = (
    built: Context.Context<SidebarSetting | UsageTracker>,
    registered: Deferred.Deferred<Registration>,
  ): Handlers => {
    const setting = Context.get(built, SidebarSetting),
      tracker = Context.get(built, UsageTracker)

    return {
      report: () =>
        tracker.report.pipe(Effect.flatMap(encodeReport), Effect.orDie),
      setSidebar: ({ shown }) =>
        setting
          .save(shown)
          .pipe(
            Effect.andThen(announce(registered, shown)),
            Effect.as({ shown }),
          ),
      sidebar: () => setting.shown.pipe(Effect.map((shown) => ({ shown }))),
    }
  }

/** The oc-usage RPC's methods, as the server plugin registers them. */
export default Object.freeze({ handlersOf })
