# Implementation Plan: Phase 0 Owner Gates

## Overview

Phase 0 source work is committed. Three owner-approved gates remain. This plan
implements gates 1 and 2 in source, then runs gate 3 as Windows execution
evidence. macOS live Quit and Linux WebKitGTK remain pending until those
machines exist.

Owner approvals (2026-08-20):

1. Narrowly scoped macOS Objective-C `applicationShouldTerminate:` hook.
2. Windows stdin/fd0 server bootstrap; omit optional fd4/fd5 telemetry.
3. Packaged app, WebView, and Tauri Pilot launches on this Windows host.

## Architecture Decisions

- Reuse the existing lifecycle machine. The macOS hook only synthesizes the
  same `NativeEvent::BeforeQuit` already handled by `RunEvent::ExitRequested`.
- Keep Unix primary spawn on `--bootstrap-fd 3` plus fd4/fd5. Windows primary
  switches to the WSL-style stdin path (`--bootstrap-fd 0`) because the native
  broker rejects additional descriptors
  (`additional file descriptors are unsupported on this platform`).
- Leave `desktopTelemetryFd` / `desktopTelemetryControlFd` unset on Windows.
  Server telemetry already treats missing fds as unavailable. Phase 1 F8 owns
  `sysinfo` metrics; do not build a Windows CRT launcher.
- `#![forbid(unsafe_code)]` cannot be overridden per module. If objc2 cannot
  express the hook without crate-local unsafe, change crate-level `forbid` to
  `deny` in `lib.rs`/`main.rs` and `#[allow(unsafe_code)]` only on the macOS
  module, with a short comment. Prefer zero crate-local unsafe.
- Gate 3 does not start until gate 2 is in the worktree. A launch against the
  current unsigned artifact would prove the old fd3 path, not the new one.

## Dependency graph

```
Gate 1 macOS terminate hook          Gate 2 Windows stdin/fd0
        (src-tauri, cfg-gated)              (desktop TS config + tests)
                         \                /
                          \              /
                     Checkpoint: both green
                                 |
                          Gate 2 Windows rebuild
                                 |
                          Gate 3 packaged smoke,
                          WebView2, Tauri Pilot
```

Safe to parallelize: Gate 1 and Gate 2 (disjoint file sets).
Must be sequential: Gate 3 after Gate 2.
Orchestrator-owned: `tasks/*`, `docs/internals/desktop-tauri.md` after both
source cards land.

## Task List

### Task 1: macOS `applicationShouldTerminate:` hook

**Description:** On macOS, Cmd+Q / Dock Quit often never reaches Tauri
`RunEvent::ExitRequested`, so `api.prevent_exit()` never runs and
`app.before-quit` never reaches `DesktopLifecycle`. Install a macOS-only
NSApplication terminate intercept that maps into the existing lifecycle.

**Acceptance criteria:**

- [ ] `#[cfg(target_os = "macos")]` hook translates Cocoa terminate into
      `NativeEvent::BeforeQuit { reason: User }` (or Menu if distinguishable).
- [ ] The hook calls the same dispatcher used by `RunEvent::ExitRequested` in
      `apps/desktop/src-tauri/src/main.rs` so prevent/before-quit/second-quit
      behavior is unchanged.
- [ ] Non-macOS builds compile with a no-op install. Windows `cargo test`
      stays green.
- [ ] No tao/wry fork. No swizzle of unrelated NSApplication methods.
- [ ] Duplicate terminate requests coalesce through the existing reentrancy
      guard; authorized continuations still pass through.

**Verification:**

- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
- [ ] `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
- [ ] Live Cmd+Q is out of scope on Windows (record as remaining V1.2 work).

**Dependencies:** None

**Files likely touched:**

- `apps/desktop/src-tauri/src/macos_terminate.rs` (new)
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/Cargo.toml` (`target.'cfg(target_os = "macos")'.dependencies`)
- existing lifecycle/app_events tests only if a mapping helper is extracted

**Estimated scope:** Medium

**Owned exclusively by:** Composer agent `gate1-macos-terminate`

### Task 2: Windows stdin/fd0 bootstrap without fd4/fd5

**Description:** `resolvePrimary` currently always uses `--bootstrap-fd 3` and
telemetry fds 4/5. The Windows broker cannot construct those CRT descriptors,
so packaged Windows smoke cannot start the Node server. Switch Windows primary
to stdin/`--bootstrap-fd 0` and omit telemetry fds. Leave darwin/linux and WSL
paths unchanged.

**Acceptance criteria:**

- [ ] `environment.platform === "win32"` primary config:
      `bootstrapDelivery: "stdin"`, args include `--bootstrap-fd` `0`,
      bootstrap JSON has no `desktopTelemetryFd` or
      `desktopTelemetryControlFd`.
- [ ] darwin/linux primary remains `bootstrapDelivery: "fd3"`, `--bootstrap-fd 3`,
      telemetry 4/5.
- [ ] WSL path remains stdin/`--bootstrap-fd 0`.
- [ ] `DesktopBackendManager` stdin delivery is reused; no broker CRT launcher.
- [ ] New focused test covers the win32 primary branch. Existing darwin
      telemetry assertions stay valid.

**Verification:**

- [ ] `vp test run apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`
- [ ] If manager tests need a stdin-primary fixture:
      `vp test run apps/desktop/src/backend/DesktopBackendManager.test.ts`
- [ ] Do not run `vp check` or repo-wide typecheck.

**Dependencies:** None

**Files likely touched:**

- `apps/desktop/src/backend/DesktopBackendConfiguration.ts`
- `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`

**Estimated scope:** Small

**Owned exclusively by:** Composer agent `gate2-windows-stdin`

### Checkpoint: Source gates

- [ ] Gate 1 and Gate 2 diffs do not overlap.
- [ ] Focused tests above are green.
- [ ] Orchestrator updates `docs/internals/desktop-tauri.md` evidence rows for
      V1.2 (hook present, live macOS Quit still pending) and V1.5 (Windows
      bootstrap boundary resolved in source).
- [ ] No commits unless the owner asks.

### Task 3: Windows packaged launch, smoke, WebView2, Tauri Pilot

**Description:** Rebuild the unsigned Windows artifact after Task 2, then
gather launch evidence. A previously built MSI/NSIS is not evidence for the
new bootstrap.

**Acceptance criteria:**

- [ ] Unsigned Windows rebuild from the post-Task-2 tree.
- [ ] Packaged binary smoke: normal boot reaches backend-ready + first
      roundtrip (`apps/desktop/scripts/tauri/smoke-test.mjs`).
- [ ] Forced-host smoke (`--kill-host`) completes.
- [ ] Topology A runner through Tauri Pilot on WebView2
      (`apps/desktop/scripts/tauri/bench/topology-a-runner.mjs`).
- [ ] WebView2 checklist cells filled from that run; WKWebView/WebKitGTK stay
      `pending`.
- [ ] WSL-from-packaged attempted if a distro is present; otherwise recorded
      as blocked on environment.

**Verification:**

- [ ] Smoke and Pilot commands exit 0; hashes and commands recorded.
- [ ] Do not treat build-only output as UI evidence.

**Dependencies:** Task 2

**Files likely touched:**

- `docs/internals/desktop-tauri.md` (orchestrator after the run)
- no product source unless a smoke harness bug is found

**Estimated scope:** Medium (execution, not source)

**Owned exclusively by:** Composer agent `gate3-windows-signoff` (spawn only
after Task 2 is in the worktree)

## Risks and Mitigations

| Risk                                                | Impact | Mitigation                                                                                                                           |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| objc2 needs crate-local unsafe under `forbid`       | High   | Isolate; `deny` + module `allow`; no crate-wide unsafe                                                                               |
| Hook fires after Cocoa already decided to terminate | High   | Intercept `applicationShouldTerminate:` and return `TerminateCancel` / `TerminateNow` (never `TerminateLater` without a later reply) |
| Windows stdin collides with host RPC stdin          | High   | Only the **server child** uses stdin for bootstrap; shell↔host RPC stays on the sidecar pipes                                        |
| Gate 3 launches pre-Task-2 artifact                 | High   | Do not spawn Task 3 until Task 2 tests are green                                                                                     |
| Telemetry silent on Windows                         | Low    | Document; F8 owns `sysinfo`                                                                                                          |
| No Mac/Linux in this environment                    | Med    | cfg-gated compile + Windows evidence only                                                                                            |

## Open Questions

None that block Tasks 1–2. Live macOS Cmd+Q and Linux AppImage remain
environment-blocked after this wave.

## Parallelization

| Agent                   | Model        | Starts       |
| ----------------------- | ------------ | ------------ |
| `gate1-macos-terminate` | composer-2.5 | immediately  |
| `gate2-windows-stdin`   | composer-2.5 | immediately  |
| `gate3-windows-signoff` | composer-2.5 | after Task 2 |

File-ownership lock: an agent may not edit another agent's files. Neither
agent edits `tasks/*` or `docs/internals/desktop-tauri.md`.
