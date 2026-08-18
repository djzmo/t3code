# Agent Nanoni desktop shell

This document records the internal Phase 0 foundation and its measurement
protocol. It is intentionally a skeleton until the owner approves packaged
artifact execution. No Electron/Tauri process, installer, browser, dev server,
or benchmark was launched while preparing this document.

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

| Webview   | Overall | Evidence                   |
| --------- | ------- | -------------------------- |
| WKWebView | pending | pending approved execution |
| WebKitGTK | pending | pending approved execution |
| WebView2  | pending | pending approved execution |

| Target    | Launch  | Core UI | Ghostty terminal | Diff panel | Drag/drop | Paste   | Popovers | Fonts   | WebSocket reconnect |
| --------- | ------- | ------- | ---------------- | ---------- | --------- | ------- | -------- | ------- | ------------------- |
| WKWebView | pending | pending | pending          | pending    | pending   | pending | pending  | pending | pending             |
| WebKitGTK | pending | pending | pending          | pending    | pending   | pending | pending  | pending | pending             |
| WebView2  | pending | pending | pending          | pending    | pending   | pending | pending  | pending | pending             |

The only Phase 0 stop condition is a blocking WebKit defect with no plausible
fix. Findings and reproduction notes belong in the result report once the
manual pass is authorized.

## Re-running the baseline

Run the harness from the repository root and keep the JSON plus rendered
Markdown report with the build artifacts. Re-run Electron against the exact
V4-final commit after `dist:desktop:*` has been rebuilt; do not compare a stale
local build to a newly packaged Tauri artifact.
