# 06: Validate credentials after expiry normalization

**What to build:** Every accepted credential remains valid after expiry is
normalized. Newly issued credentials must expire strictly after the current
time, while stored expired credentials remain readable so they can be refreshed.
The review reproduced a positive fractional stored expiry becoming zero and a
tiny positive token lifetime becoming an expiry equal to now.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Normalize expiry before the final credential validation, and ensure all
      successful credential constructors satisfy the same normalized invariant.
- [ ] Preserve finite, positive stored expiry requirements without rejecting
      ordinary expired stored credentials merely because they need refresh.
- [ ] Newly issued credentials require normalized expiry strictly after now,
      including both absolute and relative token-endpoint expiry forms.
- [ ] Tests cover fractional values around zero and now, overflow or non-finite
      results, ordinary expired stored credentials, and valid future grants.
- [ ] Invalid grants follow the existing safe transient-failure policy rather
      than producing a successful refresh with already-expired credentials.
- [ ] Run the repository checks and document any clarified boundary behavior.
