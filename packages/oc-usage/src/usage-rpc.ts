import type { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import sidebarState from "./sidebar-state.ts"
import usageReport from "./usage-report.ts"

/*
 * The RPC the server plugin registers and the CLI plugin calls. The schemas
 * are Standard Schemas, which an RPC client outside the server accepts, and
 * Effect schemas, which the server decodes and encodes with. The report
 * travels in its JSON form: the server encodes it, and the CLI decodes it.
 */
const NoInput = Schema.toStandardSchemaV1(Schema.Struct({})),
  /** Whether the sidebar shows the usage section. */
  Sidebar = Schema.toStandardSchemaV1(Schema.Struct({ shown: Schema.Boolean })),
  UsageRpc = {
    events: {
      /** The sidebar setting changed, so every CLI shows it the same way. */
      sidebarChanged: { schema: Sidebar },
    },
    id: "oc-usage",
    methods: {
      /** Every subscription's usage, measured anew when it's due. */
      report: {
        input: NoInput,
        output: Schema.toStandardSchemaV1(
          Schema.toEncoded(usageReport.UsageReport),
        ),
      },
      /** Saves whether the sidebar shows the usage section. */
      setSidebar: { input: Sidebar, output: Sidebar },
      /** Whether the sidebar shows the usage section. */
      sidebar: {
        input: NoInput,
        output: Schema.toStandardSchemaV1(sidebarState),
      },
    },
  } satisfies Rpc.PortableDefinition

/** The oc-usage RPC, shared by the server and CLI plugins. */
export default Object.freeze(UsageRpc)
