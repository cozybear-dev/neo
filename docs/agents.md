# Neo agents → DSH presets

| Neo agent | Preset id | Notes |
|-----------|-----------|-------|
| Orchestrator | `neo-orchestrator` | Top-level DSH agent; routes Fast/Thorough |
| Planner | `planner` | Thorough only; no exec except explore/browser spawn + file read |
| Agent Swarm | `swarm` | Thorough only; in-process subagents |
| Explore | `explore` | Read-oriented recon; ≤3 parallel during planning |
| Recon | `recon` | subfinder, dnsx, crt.sh, whois, httpx passive flags |
| Research | `research` | Exa search/fetch, GitHub/grep.app via Exa |
| CVE Intelligence | `cve` | vulnx + NVD/OSV/GHSA + Exa |
| ProjectDiscovery Agent | `pd-oss` | Local Nuclei + templates; PDCP HTTP only if `PDCP_API_KEY` |
| Sandbox | `sandbox` | Full toolchain via bash |
| Browser | `browser` | Playwright via CDP; no stealth/CAPTCHA |
| API Security | `api` | OpenAPI ingest, auth HTTP, GraphQL introspection |
| XSS | `xss` | Context analysis + Playwright + Interactsh blind XSS |
| Red Team Operator | `redteam` | Impacket/NetExec with scope + lockout guards |
| Ghidra | `ghidra` | GhidraMCP against `ghidra` service |
| Deploy | `deploy` | docker compose on `targets` network only |
| Vuln Triage | `triage` | Paste/attach + optional GHSA; HackerOne if token set |
| GitHub Review | `github-review` | `gh` + API; six-dimension proof gate |
| Verification (judge) | `judge` | No exec tools; spawn verifiers only |
| Verifier | `verifier` | Full exec; adversarial default = false positive |
| Summarizing | *(hook)* | `tools/post-execute`; not a user-facing agent |
| Custom Agents | disk presets | `subagent-manager` writes new preset files |
| Android | `android` | Fail-closed without `ANDROID_SERIAL` |
| iOS | `ios` | Fail-closed without `IOS_SSH_HOST` |
