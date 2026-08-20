---
name: variant-analysis
description: 'Find sibling bugs of a known sink using grep, Semgrep, and call-graph notes.'
---

# Variant analysis

Given one confirmed (or strongly suspected) sink:

1. Extract the sink API (`innerHTML`, `exec`, `pickle.loads`, raw SQL concat).
2. Grep the tree for the same API and close aliases.
3. For each hit, walk backward to sources (request params, file uploads, IPC).
4. Record reachability, not just the string match.

Write `/workspace/variants.md` as a table: path, source, sink, guard, status.

Do not file a variant that fails the six-dimension proof gate (see differential-review). Prefer fewer high-quality siblings over a wall of grep hits.
