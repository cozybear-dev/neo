# Neo remediation plan and implementation status — 2026-10-04

Basis: [comprehensive review](../reviews/2026-10-04-review.md) of `b659681c041b94722859d97b8c24e70a05e57a9a`. Implementation is in the current working tree; no commit or deployment to an existing assessment stack is implied. GPT-6.1 Sol subagents handled control/orchestration, containment/deployment, and browser/traffic/OAST, followed by integration and independent review.

## Delivery plan

1. **Establish reproducible checks.** Declare Node support; install from lockfiles; compile all packages; separate offline, database, real harness, and service checks. Generate plugin output during packaging.
2. **Close trust-boundary failures.** Move Docker administration into the broker, require task credentials and operator scope grants, isolate task artifacts, and mediate browser/replay networking.
3. **Make state and workflow authoritative.** Add revisions, transactional migrations, persisted plan approval, run identities, immutable independent verification, comments, and lifecycle state.
4. **Repair integrations.** Fix CDP discovery and isolation, durable capture, replay edits, Interactsh payload encoding and HTTP callback routing, deployment readiness and cleanup, and remote execution cancellation.
5. **Harden packaging and operations.** Pin dependencies and downloaded tools, expose actual capability limits, redact model-visible secrets, constrain summaries, and document task creation, backups, migration, and recovery.
6. **Validate the combined result.** Run the complete code/database checks, rebuild and exercise the real harness, test real broker/browser/OAST containers, inspect the worker manifest, and fix follow-up regressions.

All six delivery steps are complete. Each finding has an implemented resolution or an enforced capability limit, with the final verification record below.

## Finding-by-finding disposition

| Finding | Implemented resolution | Main verification |
| --- | --- | --- |
| F01 | Only broker has Docker socket; non-root DSH/workers; no sudo; harness guard blocks direct shell and unrestricted tools. | Real harness shell denial; worker socket/privilege tests. |
| F02 | Broker authorizes browser/replay requests and pinned DNS destination; task-owned lab networking for workers; arbitrary external scanner egress unavailable. | Real redirects/subresources/eval and control/cross-task destination denial. |
| F03 | Explicit UUID binding, task bearer credentials, operator-only scope mutation, missing task rejection, explicit IPv4 CIDR semantics. | Control auth/scope lifecycle and plugin regressions. |
| F04 | UI loopback only, DB/control unpublished, required independent credentials; DSH receives an explicit environment list. | Compose configuration and runtime auth tests. |
| F05 | Strict image-only Compose parser, validated again by broker; reject mounts, privileges, devices, host namespaces, custom networks, builds and unsupported fields. | Broker policy and deployment tests. |
| F06 | Deployment lifecycle uses broker Docker CLI; DSH no longer needs a Docker CLI or socket. Git/build deployment is explicitly unsupported. | Real image deployment and teardown. |
| F07 | Internal HTTP/WebSocket CDP relay rewrites loopback Host; Chrome CDP stays private. | Peer-container discovery and WebSocket commands. |
| F08 | Broker reaches task-owned lab targets; browser/replay reach them through mediation; lab workers join only their task network. | Real lab HTTP/browser/worker round trips. |
| F09 | Separate Interactsh registration and callback addressing; broker HTTP callback relay works from a lab target. DNS mode fails closed without configured DNS. | Generated URL callback followed by decrypted poll. |
| F10 | Correct correlation and z-base32 nonce alphabets for pinned Interactsh. | Real Interactsh interoperability and nonce regressions. |
| F11 | Dedicated worker per command; explicit cancellation removes it; no automatic replay after uncertain transport failure; quotas and deadlines. | Delayed-marker cancellation test and no-retry contract. |
| F12 | Revision-based compare-and-swap updates preserve omitted fields; stale snapshots reject. | Concurrent DB writes with explicit retry. |
| F13 | Browser contexts and filesystem namespaces bound to tasks; each agent run has a unique artifact directory. | Cookie/context and cross-task path tests. |
| F14 | Restrictive renderer files and cleanup, no world-writable task directories, shared structured/text redaction, restricted raw evidence. | Permission, guard, redaction, summarizer and harness tests. |
| F15 | Server enforces current plan approval and operator-only mode changes; issue confirmation requires immutable evidence from an independent verifier run. | Approval/revocation/mode-bypass and verification lifecycle tests. |
| F16 | Persisted task-owned deployment identity drives teardown; removal failures remain errors; partial setup rolls back. | Broker teardown, idempotence and failure tests. |
| F17 | Validated deployment IDs, explicit service/port, internal alias, readiness before success. | Traversal rejection and real non-default-port endpoint. |
| F18 | Candidate issue creation, immutable verification record, revision-aware promotion and durable comment/history records. | DB issue/comment tests and tool schemas. |
| F19 | Operator creates task; DSH verifies credentials and reads authoritative mode on startup; no incidental memory-tool bootstrap. | Startup resolver, task contracts, real harness. |
| F20 | Strict request shapes, enums and bounds; task+memory creation transaction; DB constraints; ownership checks. | Malformed input and second-insert rollback tests. |
| F21 | Executing-agent model route, bounded summary input, preserved hook contexts, cancellation propagation, raw evidence reference. | Summarizer regressions and current-source harness build. |
| F22 | Raw CDP browser connection with owned isolated target, deadlines, cancellation, disconnect and evaluation errors. | Protocol unit tests and real CDP smoke. |
| F23 | Finalized durable capture, bounded size/count, disk errors surfaced, exact request identity. | Capture/replay tests and real service smoke. |
| F24 | Canonical edited URLs, same-origin restriction, case-insensitive replacement and hop-by-hop header removal, no redirect auto-follow. | Replay and broker network tests. |
| F25 | Shared task concurrency and durable run budget, depth/deadline limits, unique run IDs, settled sibling results and truthful unavailable outcomes. | Delegate failure/concurrency/deadline tests and harness. |
| F26 | Actual worker capability manifest; supported CLI additions; Android/iOS/Ghidra agent paths fail closed; NetExec/VPN/external egress limits documented. | Worker image build and manifest; unavailable-preset tests. |
| F27 | Node/version declaration, root setup/build/check, mandatory disposable DB integration, current-source harness/service CI; generated dist removed from Git. | Documented check commands and image builds. |
| F28 | Patched Fastify/fast-uri lockfile; removed unused dependency; maintained YAML dependency updated to patched 2.9.1. | Root/control production dependency audits. |
| F29 | Locked npm, pinned core images/scanner releases, hashed Python requirements and release archives, vendored wordlists, capability inventory and application SBOM generation. | Image builds, manifests and lockfile audits. |
| F30 | Shared task credentials/identity/HTTP deadlines/redaction; maintained YAML parser; corrected tool schemas, prompts, overrides and runbook. | Typechecks, schema and YAML regressions. |

The YAML update also avoids [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp), discovered while validating the new maintained parser dependency.

## Improvement workstreams

| Item | Delivered behavior |
| --- | --- |
| I01 Operations | Structured redacted control logs, separate readiness/liveness, graceful control shutdown, bounded DB operations, transactional/checksummed migration ledger, documented backup/restore with disposable restore validation. |
| I02 Resource growth | Bounded paginated issues and indexes, bounded browser capture and worker files, expiring/deregistered OAST sessions, asynchronous RSA generation, bounded delegation budgets, operator-only retirement of terminal task records. |
| I03 Contracts | Strict successful-response decoding, meaningful broker/browser failures, current-source compilation and real pinned-harness execution in addition to local schema tests. |
| I04 Lifecycle | Durable task/run status and outcome/evidence references, independent verification history, operator inspect/approve/authorize/mode/retire commands, documented completion/cancellation. |

## Deliberate capability limits

These are enforced, documented constraints rather than successful no-op fallbacks:

- Worker commands are offline or limited to owned, approved lab containers. Arbitrary external scanners, VPN/device passthrough and privileged workloads require a separately designed runtime.
- Deploy accepts image-only specs. Git/Dockerfile builds and general Compose are rejected.
- HTTP OAST is tested through the relay. Public DNS/SMTP publication is not automatically configured.
- Android/iOS and Ghidra agent integrations are unavailable. Optional Ghidra is isolated for operator evaluation and is not a verified automated integration. NetExec is not advertised as installed.
- Database task retirement does not silently delete Docker resources or evidence volumes. Operators archive and clean matching namespaces deliberately.
- Application CycloneDX inventories cover npm dependencies; OS/scanner inventory is reported separately by the worker image. They are not a claim of a complete audited transitive image SBOM.

## Verification record

Latest combined verification (Node 22.19.0 on the host, Node 22.23.3 in DSH/control images, Docker, Compose 2.26.1):

- `npm run check`: all 12 package typechecks; **194 offline tests** and **3 disposable Postgres integration tests** passed with no skips.
- `npm run test:harness`: rebuilt the current DSH image; real parent/explore-child delegation passed, with direct shell and out-of-task reads rejected. Production plugin package inventory stays enabled.
- `npm run test:services`: real broker execution/file isolation/cancellation/deploy/cleanup checks passed; CDP discovery, task cookie isolation, mediated requests, Interactsh registration/callback/decrypted polling, and control/cross-task destination denial passed.
- Root and control `npm audit --omit=dev`: **0 vulnerabilities** in each. This is dependency advisory checking, not a claim that the application has no remaining vulnerabilities.
- `npm run sbom`: generated application CycloneDX inventories.
- `npm run build`: built all 12 packages. Current control and DSH images built successfully; Compose configuration and `git diff --check` passed.
- Disposable Compose startup: operator task creation/inspection, authenticated UI token exchange, task workspace ownership/permissions, credential separation and unauthorized API rejection passed. Fixture containers, networks and volumes were removed afterward.
- `npm run test:worker`: final pinned scanner image built on ARM64; all **26 required CLI version/help probes**, the Impacket module, and UID **1000** passed with networking disabled and capabilities dropped. Hydra intentionally returns nonzero for valid help; the gate checks its expected help text. The gate rejects broken launchers as well as missing executables. The local image ID is `sha256:ee4b24cd8cc46b8bf9de0995a2bff89f0444d827ba4df5909cba9f553cbba903`. AMD64 is configured in CI but was not built in this local verification.

Follow-up integration fixes include plugin package versions required by the harness inventory, `task_get` for revision-aware workflows, read-image filesystem confinement, terminal-task owned-resource cleanup, safe generated-output replacement during builds, and Impacket example installation/Python 3 launcher corrections. The worker gate was verified to fail against the broken launcher before passing the corrected image. See README for repeatable verification commands.
