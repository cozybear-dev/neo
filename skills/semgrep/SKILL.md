---
name: semgrep
description: 'Static analysis with public Semgrep rules. Use for code audit and variant search.'
---

# Semgrep

Run in the sandbox against a checked-out tree.

```
sandbox_exec: semgrep --config=auto --json -o /workspace/sandbox/semgrep.json /workspace/src
```

Prefer language-specific packs (`p/owasp-top-ten`, `p/javascript`, `p/java`) over unbounded `--config=auto` on huge monorepos.

## Reading results

A Semgrep hit is a sink candidate, not a confirmed vuln. For each keep:

- rule id, path, line
- whether the source is attacker-controlled
- guards between source and sink

Drop framework-false-positive patterns (escaped templates, parameterized queries). Hand remaining candidates to variant-analysis or github-review.
