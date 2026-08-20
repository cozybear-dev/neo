---
name: h1-triage
description: 'Triage using the public HackerOne API only when HACKERONE_API_TOKEN is set.'
---

# HackerOne triage (public API)

If `HACKERONE_API_TOKEN` is unset, skip H1 and triage from the pasted report alone.

## When a token exists

Use the documented REST API (`https://api.hackerone.com/v1/`) with HTTP Basic (`identifier:token`). Fetch the report, attachments metadata, and program policy. Do not scrape the HTML site.

## Verdicts

`triaged`, `needs more info`, `informative`, `duplicate`, `not applicable`, `spam` — plus a one-paragraph reason. Reproduce only in-scope assets from the policy. Never disclose to third parties from this agent.
