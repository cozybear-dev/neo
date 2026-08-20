---
name: android-security
description: 'OWASP MASVS/MASTG-oriented Android review. Fail closed without ANDROID_SERIAL.'
---

# Android security

If `ANDROID_SERIAL` is unset, stop: no Genymotion cloud in v1.

## Public methodology (MASVS / MASTG)

- Manifest: `exported` components, intent filters, `taskAffinity`, backup flags
- Storage: world-readable files, unencrypted prefs, leftover logs
- Network: cleartext, custom TrustManager, WebView JS bridges
- IPC: pending intents, deep links, file URIs

## Commands (sandbox_exec + adb)

`adb -s $ANDROID_SERIAL shell dumpsys package`, `apktool d`, `jadx`. Do not root the device unless the engagement says so.

Write component maps under `/workspace/android/`.
