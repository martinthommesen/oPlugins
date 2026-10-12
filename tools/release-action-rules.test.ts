import { describe, expect, it } from "@effect/vitest"
import layout from "./layout.test-support.ts"
import releaseActionRules from "./release-action-rules.ts"

const TAGGED = "googleapis/release-please-action@v5",
  TOOLS = "tools/package.json",
  WORKFLOW = ".github/workflows/release.yml",
  /* The problems once `file` holds `text`. */
  problemsWith = (file: string, text: string): readonly string[] =>
    releaseActionRules.problems(layout.withFile(file, text)),
  /* The valid workflow, with its step's `uses` line replaced by `line`. */
  withStep = (line: string): string =>
    layout.RELEASE_WORKFLOW.replace(`uses: ${layout.RELEASE_ACTION}`, line)

describe("the release action's pin", () => {
  it(
    "passes when the steps, record, and tools agree",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(releaseActionRules.problems(layout.VALID)).toStrictEqual([])
    },
  )

  it("needs the tools to pin what it bundles", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const tools = JSON.stringify({
      devDependencies: { "release-please": "17.5.0" },
    })

    expect(problemsWith(TOOLS, tools)).toStrictEqual([
      `${TOOLS}: devDependencies "release-please" is "17.5.0", but ${WORKFLOW} records that the release action bundles release-please 17.6.0. Set it to "17.6.0", so the offline release test runs the release-please that releases the plugins.`,
    ])
  })
})

describe("the release action's steps", () => {
  it("use the recorded action", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith(WORKFLOW, withStep(`uses: ${TAGGED}`))).toStrictEqual([
      `${WORKFLOW}: A step uses ${TAGGED}, but RELEASE_PLEASE_ACTION records ${layout.RELEASE_ACTION}. Use the recorded action, or record the new action's commit and the release-please version it bundles.`,
    ])
  })

  it("include one that runs release-please", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith(WORKFLOW, withStep("run: echo"))).toStrictEqual([
      `${WORKFLOW}: No step uses googleapis/release-please-action@. Run release-please with the action that RELEASE_PLEASE_ACTION records.`,
    ])
  })
})

describe("the release action's record", () => {
  it("pins the action to a commit", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const tagged = layout.RELEASE_WORKFLOW.replaceAll(
      layout.RELEASE_ACTION,
      TAGGED,
    )

    expect(problemsWith(WORKFLOW, tagged)).toStrictEqual([
      `${WORKFLOW}: RELEASE_PLEASE_ACTION is "${TAGGED}". Set it to googleapis/release-please-action@<commit>, with a full commit hash, because a tag such as v5 can move to an action that bundles another release-please.`,
    ])
  })

  it("is in the release-please job's env", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const unrecorded = layout.RELEASE_WORKFLOW.replace(
      "      RELEASE_PLEASE_VERSION: 17.6.0\n",
      "",
    )

    expect(problemsWith(WORKFLOW, unrecorded)).toStrictEqual([
      `${WORKFLOW}: The release-please job's env doesn't record RELEASE_PLEASE_ACTION and RELEASE_PLEASE_VERSION. Record the action's commit and the release-please version it bundles, from the action's package-lock.json.`,
    ])
  })

  it("is in a workflow that exists", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      releaseActionRules.problems(layout.withoutFile(WORKFLOW)),
    ).toStrictEqual([`${WORKFLOW}: The file is missing. Add it.`])
  })
})
