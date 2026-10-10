# OpenAI Codex Auto-review policy provenance

- Source: https://github.com/openai/codex
- Commit: `806d9732c974bc8a51b8317c1bd8985544fe627c` (committed 2026-10-10, copied 2026-10-10)
- License: Apache-2.0 (`LICENSE`, `NOTICE` copied unchanged from the repository root)

## Copied files

| Upstream path | Local path | Changes |
| --- | --- | --- |
| `codex-rs/prompts/templates/guardian/policy_template.md` | `policy_template.md` | None |
| `codex-rs/prompts/templates/guardian/policy.md` | `policy.md` | None |

`policy.ts` is generated from the two Markdown files by
`scripts/vendor-codex-policy.ts` (`pnpm run vendor:codex`). Do not edit it by
hand.

## Derived text

`messages.ts` restates short strings from Rust sources at the same commit:

- `REJECTION_INSTRUCTIONS` from
  `codex-rs/prompts/src/model_messages/guardian.rs`, unchanged.
- The output contract from `guardian_output_contract_prompt()` in
  `codex-rs/ext/guardian-reviewer/src/assessment.rs`. Modified: the opening
  sentence about read-only tool checks is replaced, because this reviewer has
  no tools.
- `OPENCODE_ENVIRONMENT` is not upstream text. It tells the reviewer that it
  cannot run the read-only inspections the template's "Investigation
  Guidelines" and "Execution Environment" sections describe, and maps the
  template's sandbox vocabulary onto OpenCode permission requests.

## Updating

Replace the Markdown files from a newer commit, run `pnpm run vendor:codex`,
re-check `messages.ts` against the Rust sources, and update this record.
