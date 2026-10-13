# Issue tracker: Local Markdown

Issues and specs live as Markdown files in `.scratch/`. Use local files rather
than GitHub Issues for this repo's engineering skills.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- The spec is `.scratch/<feature-slug>/spec.md`.
- Implementation tickets each get a file at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`. Keep one
  ticket per file rather than a combined tickets file.
- Record triage state in a `Status:` line near the top of each ticket. Use the
  role strings in `triage-labels.md`.
- Append comments and conversation history under `## Comments`.
- Preserve existing tickets in `.scratch/codebase-review/issues/`. Existing bold
  field names such as `**Status:**` and `**Blocked by:**` are equivalent to
  their plain-text forms.

## When a skill says "publish to the issue tracker"

Write the spec or individual ticket files at the paths above, creating
directories as needed.

## When a skill says "fetch the relevant ticket"

Read the referenced file. If given only a ticket number, resolve it within the
feature directory; ask if more than one feature matches.

## Wayfinding operations

Used by `/wayfinder`. The map is a file with one child file per ticket.
Wayfinding tickets track decisions, separately from implementation triage.

- **Map**: `.scratch/<effort>/map.md`, holding Notes, Decisions-so-far, and Fog.
- **Child ticket**: `.scratch/<effort>/issues/<NN>-<slug>.md`, numbered from
  `01`, with the question in the body.
- **Type**: a `Type:` line containing `research`, `prototype`, `grilling`, or
  `task`.
- **State**: a `Status:` line containing `open`, `claimed`, or `resolved`. New
  wayfinding tickets start as `open`; use these lifecycle states instead of
  implementation triage labels.
- **Blocking**: a `Blocked by: NN, NN` line near the top, referring to tickets
  in the same effort. A ticket is unblocked when every listed blocker is
  `resolved`.
- **Frontier**: scan for tickets whose status is `open` and whose blockers are
  all resolved; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under `## Answer`, set `Status: resolved`, then
  append a summary and link to Decisions-so-far in `map.md`.
