---
name: owasp-api
description: 'OWASP API Security Top 10 testing notes for OpenAPI and GraphQL.'
---

# OWASP API Security

Work from an OpenAPI document or GraphQL schema. Authenticate with provided secrets; never echo them.

## High-value tests

- **BOLA / BFLA** — change object ids and roles
- **Broken auth** — missing token, expired token, algorithm mix-up
- **Mass assignment** — extra JSON fields (`role`, `isAdmin`)
- **Resource consumption** — bounded; no unbounded DoS
- **SSRF** — webhook/URL fields with OAST
- **Unsafe consumption** — inspect third-party responses the API trusts

Hand HTML injection in error pages to `xss`. Record each request id in `/workspace/api/`.
