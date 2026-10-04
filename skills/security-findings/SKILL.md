---
name: security-findings
description: 'How to write a finding: title, impact, evidence paths, reproduction, verdict.'
---

# Security findings

Record candidate issues as unverified. Confirmation requires an independent verifier run and persisted proof.

## Shape

- **title** — attacker action + impact, not a tool name
- **severity** — critical/high/medium/low/info with a one-line justification
- **host** — allowlisted host only
- **evidence_paths** — files under the assigned task workspace a verifier can reopen
- **reproduction** — numbered steps from a clean session
- **status** — create as `unverified`; an independent verifier calls `verification_record`, then promote with `issue_update` using its proof ID and the candidate revision

## Do not

- File from Nuclei/semgrep output alone
- Paste secrets into titles
- Mark Thorough issues confirmed without independent evidence
