---
name: sqlmap-guide
description: 'Safe sqlmap usage for authorized SQL injection confirmation. Prefer low risk and scoped tests.'
---

# sqlmap (authorized only)

Use only after a strong injection hypothesis and `scope_check`.

## First pass

```
sandbox_exec: sqlmap -u '<url>' --batch --level=1 --risk=1 --technique=BEUST --output-dir=/workspace/sandbox/sqlmap
```

Start with boolean/error/union. Do not enable `--os-shell` or file-write unless the engagement says so.

## Auth and bodies

`--headers`, `--cookie`, `--data`, `-r request.txt` from `/workspace/traffic`. Never print secrets in the tool render; pass them as env.

## Safety

- `--safe-url` / `--safe-freq` on fragile apps.
- Do not use `--threads` high enough to resemble DoS.
- Stop if WAF lockout or 5xx storms begin.

DBMS fingerprint + one readable proof column is enough to claim the finding.
