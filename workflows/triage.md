# Triage task

Ingest a pasted report, attachment, or URL. Reproduce only in-scope.

## Form

- **target** — claimed asset
- **schema** — http / https / n/a
- **out-of-scope** — anything the program excludes
- **notes** — reporter context, duplicate hints
- **credentials** — if reproduction needs auth
- **report format** — default `/workspace/triage/verdict.md`
- **source** — paste / GitHub Advisory / HackerOne (token required for H1 API)

## Routing

Delegate `triage`. Optional `browser` or `sandbox` for reproduction. Do not call HackerOne without `HACKERONE_API_TOKEN`.
