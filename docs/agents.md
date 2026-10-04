# Neo agents

Each row is a specialist the harness can route to. Preset files live in `presets/`. How a task reaches them is in [Assessment workflow](workflow.md).

| Neo agent | Preset id | Notes |
|-----------|-----------|-------|
| Orchestrator | `neo-orchestrator` | Top-level DSH agent; routes Fast/Thorough |
| Planner | `planner` | Thorough only; no execution; delegates only read-only explore; persists plan with plan_submit |
| Agent Swarm | `swarm` | Thorough only; real harness subagents with task/run credentials |
| Explore | `explore` | Read-oriented recon; ≤3 parallel during planning |
| Recon | `recon` | subfinder, dnsx, crt.sh, whois, httpx passive flags |
| Research | `research` | Exa search/fetch, GitHub/grep.app via Exa |
| CVE Intelligence | `cve` | vulnx + NVD/OSV/GHSA + Exa |
| ProjectDiscovery Agent | `pd-oss` | Local Nuclei + templates; PDCP HTTP only if `PDCP_API_KEY` |
| Sandbox | `sandbox` | Constrained toolchain via sandbox_exec |
| Browser | `browser` | Raw CDP isolated task context; no stealth/CAPTCHA |
| API Security | `api` | OpenAPI ingest, auth HTTP, GraphQL introspection |
| XSS | `xss` | Context analysis + Playwright + Interactsh blind XSS |
| Red Team Operator | `redteam` | Impacket where installed; NetExec unavailable by default; task lab network only |
| Ghidra | `ghidra` | Operator-only optional isolated service; agent integration unavailable |
| Deploy | `deploy` | Strict image-only specs on task-owned internal networks |
| Vuln Triage | `triage` | Paste/attach + optional GHSA; HackerOne if token set |
| GitHub Review | `github-review` | `gh` client; network and credential capabilities required |
| Verification (judge) | `judge` | No exec tools; spawn verifiers only |
| Verifier | `verifier` | Full exec; adversarial default = false positive |
| Summarizing | *(hook)* | `tools/post-execute`; not a user-facing agent |
| Custom Agents | disk presets | Operator-managed preset files; agent writes to runtime presets blocked |
| Android | `android` | Unsupported without separately reviewed device runtime |
| iOS | `ios` | Unsupported without separately reviewed device runtime |
