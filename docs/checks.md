# Checks

These commands run on the host when you change Neo. An assessment runs through Docker Compose, as described in the [README](../README.md).

Use Node **22.19+ within 22.x, or 24+** (`.node-version` pins the tested version). Install dependencies once with `npm run setup`.

No real model credentials are used. `npm run test:offline` excludes Docker integration. A missing database or Docker daemon fails the matching integration gate. `npm run build` and image packaging generate `dist`. Those files are not source controlled.

```bash
npm run check          # all package typechecks, offline tests, disposable Postgres integration
npm run test:harness   # rebuild current DSH image, then scripted real parent/child execution
npm run test:services  # real broker, browser and Interactsh container tests
npm run test:worker    # rebuild scanner image and verify tools/non-root identity
npm run check:release  # all of the above
```

`npm run sbom` writes CycloneDX inventories to `dist/sbom/`. What those inventories cover is described in [Operations](operations.md).
