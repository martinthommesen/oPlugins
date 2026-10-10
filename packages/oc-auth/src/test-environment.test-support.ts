import { ConfigProvider, Layer } from "effect"
import type { Config } from "effect"
import Environment from "./environment.ts"

const DEFAULT_PID = 4242,
  /*
   * An `Environment` decoded from `variables`, as if they were the process
   * environment, on `platform`: a macOS machine unless a test says otherwise.
   */
  testEnvironment =
    (variables: Readonly<Record<string, string>>) =>
    (platform = "darwin"): Layer.Layer<Environment, Config.ConfigError> => {
      const provider = ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(variables),
      )

      return Environment.layerWith({
        arch: "arm64",
        nodeVersion: "v22.6.0",
        pid: DEFAULT_PID,
        platform,
      }).pipe(Layer.provide(provider))
    }

export default testEnvironment
