# 07: Validate saved advisor model preferences

**What to build:** A malformed saved model preference cannot override a valid
advisor model option or make an unusable advisor appear available. Saved
preferences and options agree on model-reference syntax, while model
availability remains a separate concern.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Decode saved model preferences with the same syntax rules used for model
      options, including provider, model, and optional variant.
- [ ] Invalid saved values are safely warned about and ignored, allowing valid
      options or defaults to take effect. Do not include rejected values in
      logs.
- [ ] Validate preference updates at the store boundary as well as reads, so an
      internal caller cannot save a model reference the next read cannot use.
- [ ] Preserve separate preference keys, legacy-record compatibility, and
      concurrent updates to unrelated preferences.
- [ ] Tests cover malformed legacy and separate-key values, valid variants,
      fallback to a valid option, and resulting availability and consultation. A
      syntactically valid unavailable model still gets its proper diagnosis.
- [ ] Run the repository checks and update preference behavior documentation.
