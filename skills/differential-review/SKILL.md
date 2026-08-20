---
name: differential-review
description: 'Review only the supplied git diff. Six-dimension proof gate for each comment.'
---

# Differential review

Stay inside the diff. Do not audit the whole repo unless asked.

## Six dimensions (all required)

1. **Attacker control** — which input, from whom
2. **Reachability** — path from source to sink in this change
3. **Sink** — what actually goes wrong
4. **Guards** — authz, allowlists, encoding, types; are they bypassable here?
5. **Framework** — what the language/framework already guarantees
6. **Impact** — confidentiality, integrity, availability, or none

If any dimension is blocked or speculative, drop the comment. Inline GitHub comments should cite file:line from the diff hunk.
