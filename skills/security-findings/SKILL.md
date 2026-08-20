---
name: security-findings
description: 'How to write a finding: title, impact, evidence paths, reproduction, verdict.'
---

# Security findings

A claim is not an issue until Thorough verification says `confirmed`.

## Shape

- **title** — attacker action + impact, not a tool name
- **severity** — critical/high/medium/low/info with a one-line justification
- **host** — allowlisted host only
- **evidence_paths** — files under `/workspace` a verifier can reopen
- **reproduction** — numbered steps from a clean session
- **verdict** — `unverified` (Fast) or `confirmed` (after verifier)

## Do not

- File from Nuclei/semgrep output alone
- Paste secrets into titles
- Mark Thorough issues confirmed without independent evidence
