# Code audit task

Review a repository or a pull request diff. Prefer differential review when a PR is given.

## Form

- **target** — repo URL or local path under `/workspace/src`
- **schema** — n/a (code)
- **out-of-scope** — vendored trees, generated code, test fixtures if excluded
- **notes** — languages, threat model, prior findings
- **credentials** — `GITHUB_TOKEN` if commenting on a PR
- **report format** — default `/workspace/github-review/report.md`
- **range** — full tree vs PR diff / SHA range

## Routing

- PR/diff: `github-review` with the six-dimension proof gate.
- Full tree: `sandbox` + `semgrep` skill, then `variant-analysis` on the interesting sinks.
- Thorough: still send exploitability claims through `judge` / `verifier` before filing.
