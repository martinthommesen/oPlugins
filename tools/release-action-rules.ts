import { Array as Arr, Option, Record as Rec, Result, Schema } from "effect"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"
import { parseDocument } from "yaml"

type Files = (typeof Snapshot.Type)["files"]

const ACTION = "googleapis/release-please-action@",
  /** A full commit hash, which can't move the way a tag like `v5` can. */
  COMMIT = /^[0-9a-f]{40}$/u,
  JOB = "release-please",
  PACKAGE = "release-please",
  /** The action and the release-please version it bundles, as recorded. */
  Recorded = Schema.Struct({
    RELEASE_PLEASE_ACTION: Schema.optionalKey(Schema.String),
    RELEASE_PLEASE_VERSION: Schema.optionalKey(Schema.String),
  }),
  /** What the checks read from a step in `release.yml`. */
  Step = Schema.Struct({ uses: Schema.optionalKey(Schema.String) }),
  TOOLS = "tools/package.json",
  /** What the checks read from a job in `release.yml`. */
  Task = Schema.Struct({
    env: Schema.optionalKey(Recorded),
    steps: Schema.optionalKey(Schema.Array(Step)),
  }),
  WORKFLOW = ".github/workflows/release.yml",
  /** What the checks read from `release.yml`: its jobs. */
  Workflow = Schema.Struct({ jobs: Schema.Record(Schema.String, Task) }),
  /* The steps' release-please action references, each as written. */
  actionsIn = (workflow: typeof Workflow.Type): readonly string[] =>
    Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .flatMap((step) => Option.toArray(Option.fromUndefinedOr(step.uses)))
      .filter((uses) => uses.startsWith(ACTION)),
  asWorkflow = Schema.decodeUnknownResult(Workflow),
  /* `tools/package.json` pins release-please at `version`. */
  checkPin = (files: Files, version: string): readonly string[] =>
    Result.match(layoutFiles.manifestAt(files, TOOLS), {
      onFailure: (problem) => [problem],
      onSuccess: (manifest) => {
        const pinned = Rec.get(manifest.devDependencies ?? {}, PACKAGE)

        return layoutFiles.reportIf(
          !Option.contains(pinned, version),
          TOOLS,
          `devDependencies "${PACKAGE}" is ${layoutFiles.quoted(pinned)}, but ${WORKFLOW} records that the release action bundles release-please ${version}. Set it to "${version}", so the offline release test runs the release-please that releases the plugins.`,
        )
      },
    }),
  /* The recorded action is pinned to a commit, and every step uses it. */
  checkSteps = (
    workflow: typeof Workflow.Type,
    recorded: string,
  ): readonly string[] => {
    const used = actionsIn(workflow)

    return [
      ...layoutFiles.reportIf(
        !recorded.startsWith(ACTION) ||
          !COMMIT.test(recorded.slice(ACTION.length)),
        WORKFLOW,
        `RELEASE_PLEASE_ACTION is "${recorded}". Set it to ${ACTION}<commit>, with a full commit hash, because a tag such as v5 can move to an action that bundles another release-please.`,
      ),
      ...layoutFiles.reportIf(
        !Arr.isReadonlyArrayNonEmpty(used),
        WORKFLOW,
        `No step uses ${ACTION}. Run release-please with the action that RELEASE_PLEASE_ACTION records.`,
      ),
      ...Arr.dedupe(used.filter((uses) => uses !== recorded)).map((uses) =>
        layoutFiles.at(
          WORKFLOW,
          `A step uses ${uses}, but RELEASE_PLEASE_ACTION records ${recorded}. Use the recorded action, or record the new action's commit and the release-please version it bundles.`,
        ),
      ),
    ]
  },
  /* The workflow from its YAML `text`, or what's wrong with it. */
  parsed = (
    text: string,
  ): Result.Result<typeof Workflow.Type, { readonly message: string }> => {
    const document = parseDocument(text),
      errors = document.errors.map((error: { readonly message: string }) =>
        error.message.trim(),
      )

    if (Arr.isReadonlyArrayNonEmpty(errors)) {
      return Result.fail({ message: errors.join(" ") })
    }

    return asWorkflow(document.toJS())
  },
  /* The recorded action and the version it bundles, each checked. */
  recordedProblems = (
    files: Files,
    workflow: typeof Workflow.Type,
  ): readonly string[] => {
    const env = Option.fromUndefinedOr(workflow.jobs[JOB]).pipe(
        Option.flatMap((job) => Option.fromUndefinedOr(job.env)),
      ),
      recorded = env.pipe(
        Option.flatMap((values) =>
          Option.all({
            action: Option.fromUndefinedOr(values.RELEASE_PLEASE_ACTION),
            version: Option.fromUndefinedOr(values.RELEASE_PLEASE_VERSION),
          }),
        ),
      )

    return Option.match(recorded, {
      onNone: () => [
        layoutFiles.at(
          WORKFLOW,
          `The ${JOB} job's env doesn't record RELEASE_PLEASE_ACTION and RELEASE_PLEASE_VERSION. Record the action's commit and the release-please version it bundles, from the action's package-lock.json.`,
        ),
      ],
      onSome: ({ action, version }) => [
        ...checkSteps(workflow, action),
        ...checkPin(files, version),
      ],
    })
  },
  /*
   * Every problem with the release action's pin: the workflow records the
   * action and the release-please version it bundles, every step uses that
   * action, and the tools pin that release-please.
   */
  workflowProblems = (snapshot: typeof Snapshot.Type): readonly string[] =>
    Result.match(layoutFiles.decodedAt(snapshot.files, WORKFLOW, parsed), {
      onFailure: (problem) => [problem],
      onSuccess: (workflow) => recordedProblems(snapshot.files, workflow),
    })

/**
 * The check that the tools run the release-please the release action
 * bundles.
 */
export default Object.freeze({ problems: workflowProblems })
