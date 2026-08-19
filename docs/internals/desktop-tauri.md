# Agent Nanoni desktop shell

This document records the internal Phase 0 foundation, acceptance evidence,
and measurement protocol. Windows debug and unsigned release artifacts have
been built locally. The cross-platform measurements and compatibility passes
remain pending; a build artifact is not treated as evidence for a launch,
smoke, or UI-compatibility requirement.

## Phase 0 evidence

Evidence current on 2026-08-20:

| Objective | Current evidence                                                                                                                                                                                                                                                                                                                                                   | Remaining acceptance work                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V0        | Recorder and focused tests are green.                                                                                                                                                                                                                                                                                                                              | Run Electron and final Tauri measurements on Windows, macOS, and Linux.                                                                                                               |
| V1.0      | Shared TypeScript/Rust protocol fixtures, release guard, toolchain alignment, and CI jobs are implemented.                                                                                                                                                                                                                                                         | Record a green external CI run.                                                                                                                                                       |
| V1.1      | The real desktop composition and server run under the FakeShell integration test. The test now proves the authoritative HTTP readiness receipt, active native registration, reveal ordering, and managed cleanup; derived process helpers have an explicit C1 audit.                                                                                               | Exercise the SSH spawn path in an environment with a real SSH target.                                                                                                                 |
| V1.2      | Framing, lifecycle, native process broker, retained process identity, shared Unix host-group cleanup, containment unit tests, the real `DesktopLifecycle`/`DesktopUpdates` integration proof, and a macOS-only `applicationShouldTerminate:` hook that feeds the existing `ExitRequested` dispatcher. Live Cmd+Q is still unverified (no Mac in this environment). | Confirm Cmd+Q / Dock Quit on macOS and complete three-OS containment fixtures.                                                                                                        |
| V1.3      | Invoke, push, sync boot values, navigation guards, and the external-URL allow-list have TypeScript and Rust coverage. Packaged WebView2 smoke completed a real `host_invoke` round-trip.                                                                                                                                                                           | Record the remaining integrated UI compatibility matrix.                                                                                                                              |
| V1.4      | Shim, development loop, identity overlay, and home isolation are implemented. V1b is **not selected** because the init-script shim supplies the existing `DesktopBridge` contract without a web adapter.                                                                                                                                                           | Confirm the rest of the core-UI checklist in an attended pass.                                                                                                                        |
| V1.5      | Staging, payload validation, smoke harnesses, and Windows packaging are implemented. Windows primary uses stdin/`--bootstrap-fd 0`. Packaged debug smokes (normal + `--kill-host`) both passed on 2026-08-20.                                                                                                                                                      | macOS/Linux packaged smokes remain environment-blocked.                                                                                                                               |
| V1.6      | Debug and release artifact matrices are defined for all three operating systems.                                                                                                                                                                                                                                                                                   | Obtain a green matrix, three-webview UI evidence, and LAN/Tailscale web/mobile remote-readiness evidence.                                                                             |
| V2        | The gated real-bridge benchmark now measures 1,000 round trips, 100 renderer-scheduled pushes, exact 1 MiB throughput, reload stability, and failure behavior without synthetic timing. No performance result is claimed yet.                                                                                                                                      | Run the benchmark through Tauri Pilot on WebView2, WKWebView, and WebKitGTK and record the measured criteria.                                                                         |
| V3a       | Exact remote CLI/version pins, grammar, computed closure, npm surface, and fallback policy are implemented. The live registry and Sigstore/SLSA verification passed again on 2026-08-19.                                                                                                                                                                           | Exercise one pinned SSH provisioning pass.                                                                                                                                            |
| V3b       | Boot metadata and version-skew tests are implemented.                                                                                                                                                                                                                                                                                                              | Confirm all values at first evaluation in the packaged UI.                                                                                                                            |
| V4-final  | On commit `173852b944c5c9ec963f579ce7eabc17286dcf7a`, the unsigned Windows release build produced a 10,711,040-byte executable, a 75,354,479-byte MSI, and a 48,198,955-byte NSIS installer. The validated stage contained 1,194 files totaling 241,153,611 bytes.                                                                                                 | Rebuild after the owner-gated platform changes on all three operating systems, run smokes, boot WSL from packaged resources, and launch the AppImage on a newer Wayland distribution. |
| V5        | This evidence ledger and the measurement schema exist.                                                                                                                                                                                                                                                                                                             | Fill the final measurements, compatibility findings, V2/V3 outcomes, remote-readiness result, and timed upstream-tag merge.                                                           |

Windows primary bootstrap is stdin/`--bootstrap-fd 0` with telemetry fds
omitted. Unix primary keeps fd 3 plus optional fd 4/fd 5.

Packaged debug smokes on 2026-08-20 (exe SHA-256
`e42aeed75c3e79d84a65ea72b30d21a06919442d3fe6637f3678df7d79001dc8`):

- `node apps/desktop/scripts/tauri/smoke-test.mjs --bundle <exe>` passed
  (`AGENT_NANONI_SMOKE backend-ready` and `first-roundtrip`).
- `--kill-host` passed.

The smoke-blocking defects that had to land first were: Windows stdin Stream
pump in `BrokeredChildSpawner`, a smoke-only renderer `host_invoke` probe,
allowing WebView2 `about:blank` before the app origin is set, and writing a
`src-tauri`-relative `frontendDist` in `tauri.phase0.conf.json` (an absolute
path made wry load `file://`, which the same-origin guard rejects).

Debug bundle hashes from that passing rebuild:

- MSI: `5e8cc435620e1f4010951169b1d50a81adef3ed5fe359c6fb7d3f66bae9d350f`
- NSIS: `b09c5cbb405baa38cf1bdc4b43a769411473ac6c1c7b6469507feb8bdd86679a`

Skipped while unattended: three-OS measurements, live macOS Cmd+Q, Linux
AppImage/WebKitGTK, LAN/Tailscale remote-readiness, attended core-UI matrix
beyond the smoke round-trip, WSL-from-packaged if it needs interactive
approval, and Topology A / Tauri Pilot. Pilot needs a separate debug build
with `--features topology-a-pilot`; a prior attach failed with `No tauri-pilot
instances directory found`. That is not a source merge blocker.

The previous unsigned release hashes (pre-stdin, not a launch) were:

- executable: `8B3D918EBF0F4409FA9ABC5EE9BBD76D50E12672C9745A7EB60F051BB3885634`;
- MSI: `0AE7AE8EAEA5836776EFB81DC55BB3AFE3295EAA66C0951223658AAAA350B3BB`;
- NSIS: `4F4425CE7F19127057585BCE1376E3DAACFC62457EE213A296E6A234B172822C`.

This release was built with the repository's pinned Node 24 runtime first on
the subprocess `PATH`; the host machine's Node 22 installation remained later
on `PATH`. This proves the artifact wrapper no longer allows nested Vite or
package scripts to silently select the unsupported system runtime.

## Identity

The owner froze D-ID on 2026-08-18. Agent Nanoni uses namespaces that are
distinct from T3 Code and does not migrate Electron data:

| Surface                                       | Packaged identity                         |
| --------------------------------------------- | ----------------------------------------- |
| Bundle identifier                             | `app.nanoni.agent.desktop`                |
| Product and display name                      | `Agent Nanoni`                            |
| Executable, installer directory, and WM class | `AgentNanoni`                             |
| URL scheme                                    | `agent-nanoni`                            |
| Node sidecar                                  | `agent-nanoni-node`                       |
| Data home                                     | the absolute OS-home path `.agent-nanoni` |
| Linux desktop entry                           | `agent-nanoni.desktop`                    |
| Windows AppUserModelId                        | `app.nanoni.agent.desktop`                |
| Safe-storage account                          | `safe-storage-key`                        |

Development identity is isolated per worktree. The development bundle and
single-instance identifier are
`app.nanoni.agent.desktop.dev.<worktree-id>`, where `worktree-id` is the short
hash of the canonical worktree path after resolving symlinks or junctions and
normalizing Windows drive-letter case. The development data home is the
worktree-local `.t3/tauri`; the packaged URL scheme is not registered in
development. Development keychain services use the same worktree-specific
identifier and the `safe-storage-key` account.

Updater repository/endpoint values, the minisign public-key slot, Apple Team
ID, and signing credentials remain intentionally unset in Phase 0. They do not
change the frozen application namespaces above.

## Baseline (V0)

The V0 baseline compares Electron and the eventual Tauri V4-final artifact
from the same commit. The workload and machine are held constant:

- one project and one idle thread;
- terminal open;
- seeded state produced with `VACUUM INTO`;
- identical configuration and branding;
- five minutes of idle time.

The recorder lives in
[`apps/desktop/scripts/tauri/bench/`](../../apps/desktop/scripts/tauri/bench/README.md).
It only consumes observations, so an approved execution can be reproduced
without changing the recorder:

1. record one installer size and one installed-payload size;
2. sample the complete application process tree every 10 seconds for five
   minutes, for at least three runs;
3. reduce each RSS and CPU run to a median, then take the median of those run
   medians;
4. measure five cold launches from process start to backend-ready and report
   their median.

### Baseline results

All cells are pending approved execution. A pending cell is not a zero and is
not an estimate.

| OS      | Runtime  | Installer size | Installed size | Idle RSS (tree) | Idle CPU (informational) | Cold start (5-launch median) | Commit  | Notes               |
| ------- | -------- | -------------: | -------------: | --------------: | -----------------------: | ---------------------------: | ------- | ------------------- |
| Windows | Electron |        pending |        pending |         pending |                  pending |                      pending | pending | not measured        |
| macOS   | Electron |        pending |        pending |         pending |                  pending |                      pending | pending | not measured        |
| Linux   | Electron |        pending |        pending |         pending |                  pending |                      pending | pending | not measured        |
| Windows | Tauri    |        pending |        pending |         pending |                  pending |                      pending | pending | V4-final comparison |
| macOS   | Tauri    |        pending |        pending |         pending |                  pending |                      pending | pending | V4-final comparison |
| Linux   | Tauri    |        pending |        pending |         pending |                  pending |                      pending | pending | V4-final comparison |

The size and RSS expectations are informational (not a Phase 0 gate):

| Metric                            |         Expected |  Investigate if |
| --------------------------------- | ---------------: | --------------: |
| Installer size (Tauri / Electron) |            ≤ 55% |           > 75% |
| Installed size (Tauri / Electron) |            ≤ 60% |           > 80% |
| Idle RSS (Tauri / Electron)       |            ≤ 70% |           > 85% |
| Cold start                        | ≤ Electron + 10% | > 1.5× Electron |

## Result schema

Each runtime/OS pair is a versioned JSON result (`schemaVersion: 1`) with:

- commit, build, machine, and artifact metadata;
- the fixed workload and the 10-second/5-minute/three-run protocol;
- installer and installed bytes;
- raw process-tree samples, per-run medians, and the median-of-medians;
- five launch durations and their median;
- the WebKit compatibility checklist;
- explicit `pending` values where approved execution has not happened.

The pure helpers reject fewer than three idle runs, a protocol other than 10
seconds over five minutes, and a cold-start set other than five launches. They
sum only the selected root process and descendants, so unrelated user tools do
not enter RSS/CPU totals.

## WebKit compatibility checklist

The following is a manual report skeleton. Evidence is required for every
status change. A WebKitGTK pass must include one packaged AppImage launch on a
newer Wayland distribution (Tauri issue #15665 context).

| Webview   | Overall    | Evidence                                                                                                                                         |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| WKWebView | pending    | pending approved execution                                                                                                                       |
| WebKitGTK | pending    | pending approved execution                                                                                                                       |
| WebView2  | smoke-pass | Packaged debug smoke reached `first-roundtrip` (`host_invoke`) on 2026-08-20. Core-UI matrix not filled (unattended; no integrated client pass). |

| Target    | Launch  | Core UI | Ghostty terminal | Diff panel | Drag/drop | Paste   | Popovers | Fonts   | WebSocket reconnect |
| --------- | ------- | ------- | ---------------- | ---------- | --------- | ------- | -------- | ------- | ------------------- |
| WKWebView | pending | pending | pending          | pending    | pending   | pending | pending  | pending | pending             |
| WebKitGTK | pending | pending | pending          | pending    | pending   | pending | pending  | pending | pending             |
| WebView2  | pass    | pending | pending          | pending    | pending   | pending | pending  | pending | pending             |

The only Phase 0 stop condition is a blocking WebKit defect with no plausible
fix. Findings and reproduction notes belong in the result report once the
manual pass is authorized.

## Re-running the baseline

Run the harness from the repository root and keep the JSON plus rendered
Markdown report with the build artifacts. Re-run Electron against the exact
V4-final commit after `dist:desktop:*` has been rebuilt; do not compare a stale
local build to a newly packaged Tauri artifact.
