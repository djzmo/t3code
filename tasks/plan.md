# Phase 0 Plan: Agent Nanoni Tauri Foundation

## Authority and scope

Implement Phase 0 from `C:/Users/me/.claude/plans/you-are-working-on-swift-spindle.md`
revision 26. Section 6 and Appendix B are the operative requirements. This file only
records execution order and ownership; it does not amend the frozen architecture.

- Actual implementation baseline: `v0.0.34-nightly.20260817.1120` (`a4cc1367`).
- Canonical remote CLI pin: `v0.0.34-nightly.20260817.1116`; its server closure is
  unchanged at the implementation baseline.
- Phase 1, Phase 2, publishing, signing, and production credentials are out of scope.
- Electron modules remain intact. Fork work stays in the paths allowed by section 12.
- Topology A is the only active renderer transport. Topology B remains parked.

## Open gates

- D-ID: owner must freeze the working identity values before V1.2 starts.
- Rust: no Rust toolchain is installed on the current Windows host. Rust verification
  starts after the owner approves a user-level toolchain installation or provides one.
- Browser/computer-use, LAN/Tailscale, packaged Wayland, and three-OS manual checks
  require execution-time owner approval where rev 26 marks them with the stop sign.

## Dependency graph and execution waves

### Wave 1: foundations

1. V3-policy: record tags-only sync, the actual upstream baseline, product version,
   and remote CLI pin inputs.
2. V0: add the reproducible Electron benchmark harness and report skeleton. Running
   the full three-OS baseline is a later approved/manual activity.
3. V1.0: implement the complete Appendix B RPC schemas and fixtures, the matching
   Rust serde model, minimal Tauri CI, release-workflow guard, and toolchain-alignment
   test.

V0 and V3-policy are parallel-safe. V1.0 owns the shared protocol, fixture, crate,
capability, and CI integration surfaces.

### Wave 2: host and shell

4. V1.1: boot the unchanged `DesktopApp.program` under Tauri service layers and a
   `FakeShell`; decorate the only host `ChildProcessSpawner` boundary.
5. V1.2: after D-ID, implement the Tauri shell, framed RPC supervision, sidecar
   acquisition, lifecycle state machine L, and containment invariants C1-C7.

V1.1 and V1.2 may run in parallel after V1.0, with V1.0 retaining ownership of
`protocol.ts`, fixtures, `protocol.rs`, `src/tauri/main.ts`, `Cargo.toml`, and
capabilities.

### Wave 3: first vertical slice

6. V1.3: integrate one secure invoke/push/sync path and external-URL validation.
7. V1.4: boot the real SPA on the development OS, complete the bridge/chrome/dev
   loop, and decide V1b from evidence.
8. V1b: implement only if V1.4 proves initialization-script injection fragile.

### Wave 4: versioning and packaging

9. V3a: pin the remote CLI to the upstream tag and implement product/compat version
   resolution and provenance checks.
10. V3b: inject renderer version metadata and preserve browser fallback behavior.
11. V1.5: stage the resource layout and build a preliminary debug package.

V3a can begin after V1.1. V3b begins after V1.4 and converges with V1.5 for its
packaged smoke test.

### Wave 5: hardening and evidence

12. V1.6: harden on all three operating systems, extend CI, perform the approved
    client compatibility and remote-readiness passes, and time one release-tag merge.
13. V2: measure Topology A and enforce its ordering, latency, and reload criteria.
14. V4-final: produce unsigned three-OS packages from the post-V2 tree and rerun V0.
15. V5: finish `docs/internals/desktop-tauri.md` with all measurements and decisions.

## Increment rules

- Write the acceptance test or fixture before behavioral code.
- Keep each implementation card to one owned module group, normally no more than
  five files, and run its focused tests before integration.
- Do not run repository-wide checks. Use focused `vp test run`, package typecheck,
  Cargo tests/clippy, and the exact canonical acceptance commands.
- Subagents do not start dev servers or browsers. The primary orchestrator performs
  one integrated client pass after integration and only with owner approval.
- Review tests first, then correctness, simplicity, architecture, security, and
  performance before marking a card complete.

## Completion criteria

Phase 0 is complete only when every V0-V5 canonical acceptance item is satisfied,
the unsigned installers exist for all three operating systems, focused verification
is green, the documentation is current, and all required manual/external-action
evidence has owner approval.
