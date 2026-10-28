import { Duration } from "effect"

const CONNECTION_SECONDS = 45,
  HTTP_SECONDS = 15,
  REPORT_SECONDS = 75,
  RPC_SECONDS = 90,
  SETTING_SECONDS = 15

/* Resolution, transport, and semaphore waiting have separate bounded budgets. */
export default Object.freeze({
  connection: Duration.seconds(CONNECTION_SECONDS),
  http: Duration.seconds(HTTP_SECONDS),
  report: Duration.seconds(REPORT_SECONDS),
  rpc: Duration.seconds(RPC_SECONDS),
  setting: Duration.seconds(SETTING_SECONDS),
})
