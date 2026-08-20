---
name: runtime-validation
description: 'Confirm a static finding at runtime with HTTP, browser, or OAST evidence.'
---

# Runtime validation

Static hits need a live check.

1. Replay the suspected request (`traffic_replay` or sandbox_exec curl) against the allowlisted host.
2. Observe a security boundary crossing: data read, auth bypass, script execution, outbound OAST.
3. Capture status, body excerpt, screenshot, or OAST interaction id.
4. Negative control: same request with the sink neutralized should not fire.

If the app sanitizes the payload, record `false_positive` plus the guard you hit. Do not escalate to blind fuzzing without a new hypothesis.
