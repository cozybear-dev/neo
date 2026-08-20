---
name: ios-security
description: 'OWASP MASVS/MASTG-oriented iOS review. Fail closed without IOS_SSH_HOST.'
---

# iOS security

If `IOS_SSH_HOST` is unset, stop: no jailbroken-iPhone lab in v1.

## Public methodology (MASVS / MASTG)

- Info.plist URL schemes and ATS exceptions
- Keychain accessibility attributes
- Local storage (NSUserDefaults, files outside the container)
- WKWebView script handlers and universal links

## Access

SSH to `$IOS_SSH_HOST` via sandbox_exec only when authorized. Do not jailbreak. Prefer static IPA review (`class-dump`, `otool`, `strings`) when the device is absent — and still mark runtime checks as blockers.
