# Upstream sync policy

> For maintainers of the Agent Nanoni fork.

Agent Nanoni lands upstream release tags only. A raw `upstream/main` checkout may be
used on a disposable preview branch to measure merge effort, but it is never a
product baseline. After landing a release tag, update the pin below and run the
V3a remote-CLI checker before building the desktop shell.

## Phase 0 baseline

Phase 0 started from commit `a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2`, the upstream tag
`v0.0.34-nightly.20260817.1120`. The canonical compatibility pin remains the earlier approved
release tag `v0.0.34-nightly.20260817.1116` until the owner explicitly retargets it. That tag
is an ancestor of the fork's implementation history.

The commits between those tags change only web/mobile presentation code. They do not change
the server compatibility closure: `apps/server/**`, the server's transitive workspace
dependencies, the reachable server build-script imports, the server importer's lockfile
subset, or matching catalog/patch entries. V3a's computed closure check is the authoritative
verification; this note records the baseline evidence and does not replace that checker.

The current pin is:

```json
{
  "upstreamTag": "v0.0.34-nightly.20260817.1116",
  "packageSpec": "t3@0.0.34-nightly.20260817.1116"
}
```

`packageSpec` is derived from the exact tag by removing only the leading `v`; it is not
derived from `apps/server/package.json`, whose source version is rewritten only when upstream
publishes. The V3a checker verified this package's Sigstore/SLSA provenance on 2026-08-18, so
`tarballIntegrity` is intentionally absent. It may be recorded only by the checker's fallback
path when the pinned package is unattested at pin time.

## Product and compatibility versions

`apps/desktop/src-tauri/product-version.json` is the fork's stable product-version seed:

```json
{
  "productVersion": "1.0.0"
}
```

The V3a `resolve-product-version.ts` script is the sole authority for consuming this file,
deriving nightly versions, and validating the upstream version grammar. The fork's
`productVersion` is independent from the pinned upstream compatibility version. For this
baseline the latter is `0.0.34-nightly.20260817.1116`; the build pipeline applies it to the
four upstream release manifests before producing the web/server bundle, while Tauri receives
the fork product version through its build configuration.

## Updating the pin

1. Land one upstream release tag on the product branch.
2. Set `upstreamTag` and `packageSpec` to that exact tag/version pair.
3. Run `scripts/tauri/check-remote-cli-pin.ts` (with a full, non-shallow checkout).
4. Run the focused desktop typecheck/tests and record the sync effort.

Do not edit `packages/contracts`, `apps/server`, or the root `vite.config.ts` to make a pin
pass. A server-closure change requires the separately authorized fork-package contingency;
there is no default fork npm publication.

The initial V3a registry and provenance verification passed on 2026-08-18 with a full,
non-shallow checkout. The checker confirmed tag ancestry, the computed server/build-script
closure, the npm package surface, and the Sigstore/SLSA claims. No npm publication or upstream
contact was performed.
