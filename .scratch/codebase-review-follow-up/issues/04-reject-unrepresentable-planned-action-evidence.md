# 04: Reject unrepresentable planned-action evidence safely

**What to build:** Auto-review either gives the reviewer a faithful planned
action or leaves the permission prompt with the user in an explained ask
verdict. Unsupported metadata must neither silently change meaning during JSON
encoding nor turn the permission hook into an unexplained defect. BigInt
metadata reproduced the defect; non-finite numbers and undefined values can also
change the evidence the reviewer sees.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Validate that planned-action metadata can be represented faithfully before
      requesting an assessment. Reject unsupported values rather than dropping
      fields, coercing values, or truncating evidence.
- [ ] Cover nested undefined values, non-finite numbers, BigInt, and cyclic
      structures. Ordinary omitted optional metadata remains valid.
- [ ] Encoding or validation failure follows the typed unavailable-context path
      and completes with an ask verdict explaining why review was unavailable.
      The reviewer is not called for invalid evidence.
- [ ] Diagnostics do not include raw metadata, prompts, tokens, or schema errors
      that quote their contents.
- [ ] Tests through the registered permission hook cover invalid evidence and
      valid JSON metadata, preserving tool-call matching, size limits, and
      explicit allow or deny rules that auto-review must not override.
- [ ] Update the fail-safe documentation and run the repository checks. Do not
      describe the original defect as a demonstrated permission bypass.
