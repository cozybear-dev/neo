---
name: redteam
description: 'Assumed-breach tradecraft with lockout guards. Use for authorized AD/Windows/Linux post-auth testing.'
---

# Red Team Operator

Assumed-breach only. Confirm allowlist and a written rules-of-engagement note before any auth attempt.

## Lockout

- Stop a password spray after 3 failures per account (or the engagement cap).
- Never spray the built-in administrator across a domain in one burst.
- Prefer password-not-required / kerberoast / AD CS over guessing.

## OPSEC

- Record which host ran which tool and when (`/workspace/redteam/opsec.md`).
- Avoid workstation-wide ransomware simulations and disk wipes.
- No DoS, no mass account lockout, no WAN-facing listener without approval.

## Tooling (via sandbox_exec)

Impacket (`secretsdump`, `GetUserSPNs`), NetExec/CrackMapExec, kerbrute (with lockout math), BloodHound collectors only when approved.

## Stop conditions

Domain-wide lockout risk, out-of-scope DC, or a control that would take production down → record a blocker and stop.
