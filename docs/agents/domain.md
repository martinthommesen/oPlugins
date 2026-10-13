# Domain docs

This repo uses a multi-context layout: a root glossary map links shared
vocabulary and per-plugin glossaries.

## Before exploring

- Read `GLOSSARY-MAP.md` at the repo root.
- Read `docs/GLOSSARY.md` for shared vocabulary and each mapped plugin glossary
  relevant to the task.
- Read ADRs in `docs/adr/` that touch the area being changed.
- If a plugin has `packages/<plugin>/docs/adr/`, read relevant decisions there
  too.

If a domain document is absent, proceed silently. Domain documents are created
lazily through `/domain-modeling` when terms or decisions are resolved.

## Layout

- `GLOSSARY-MAP.md`: the index of contexts and their relationships.
- `docs/GLOSSARY.md`: vocabulary shared across the repo.
- `packages/<plugin>/GLOSSARY.md`: plugin-specific vocabulary, as linked from
  the map.
- `docs/adr/`: repository-wide architecture decisions.
- `packages/<plugin>/docs/adr/`: plugin-scoped decisions, if present.

Use the map as the source of truth for which contexts exist.

## Use the glossary's vocabulary

Use defined terms in issue titles, proposals, hypotheses, test names, and other
output. Respect each glossary's explicitly avoided synonyms.

If a needed concept is missing, reconsider whether it belongs to the domain;
note genuine vocabulary gaps for `/domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, name the conflict explicitly and
explain why the decision may need reopening rather than silently overriding it.
