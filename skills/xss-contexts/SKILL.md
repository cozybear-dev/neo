---
name: xss-contexts
description: 'Classify XSS sink context first, then pick a small payload and confirm in the browser.'
---

# XSS contexts

Do not start with a 200-character polyglot.

| Context | Tell | First payload idea |
|---|---|---|
| HTML body | reflected in text nodes | `<img src=x onerror=alert(1)>` |
| Attribute | inside `value="…"` | `" autofocus onfocus=alert(1) x="` |
| JS string | inside quotes in a script | `';alert(1)//` |
| URL | `href` / `src` | `javascript:alert(1)` |
| Template | `{{` / `{%` | framework-specific, often not XSS |

Confirm with `browser_eval` / screenshot. For blind XSS, `oast_register` and a unique path. CSP, HttpOnly, and Trusted Types are guards to document, not skip reasons if a sink still fires.
