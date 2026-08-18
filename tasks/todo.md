# Agent Nanoni Phase 0

## Gates

- [x] Reconcile the repository baseline with the frozen plan.
- [ ] Freeze D-ID with the owner.
- [ ] Establish the pinned Rust toolchain.
- [ ] Obtain approval before each marked browser/computer-use or remote manual pass.

## Wave 1

- [x] V3-policy: tags-only baseline, product version, and remote CLI pin seed.
- [x] V0: Electron benchmark harness and report baseline section.
- [x] V1.0a: TypeScript Appendix B schemas and positive fixtures.
- [x] V1.0b: framing, limit, and failure fixtures.
- [ ] V1.0c: Rust crate and matching serde protocol model.
- [ ] V1.0d: bidirectional fixture drift/round-trip tests.
- [x] V1.0e: release-workflow guard and guard test.
- [ ] V1.0f: toolchain pin and alignment test.
- [ ] V1.0g: minimal three-OS Tauri CI.

## Wave 2

- [x] V1.1a: Tauri host composition and environment layer.
- [x] V1.1b: Tauri app/Clerk lifecycle facade.
- [x] V1.1c: IPC and bounded service stubs.
- [x] V1.1d: window facade, FakeShell, and host integration test.
- [x] V1.1e: managed child-spawner decorator and spawn-boundary audits.
- [ ] V1.2a: Tauri application/capability scaffold.
- [ ] V1.2b: framed RPC transport and peer supervision.
- [ ] V1.2c: official Node sidecar acquisition.
- [ ] V1.2d: lifecycle state machine L and exhaustive tests.
- [ ] V1.2e: smallest containment mechanism satisfying C1-C7 and its race tests.

## Wave 3

- [ ] V1.3: secure invoke/push/sync vertical slice and URL parity tests.
- [ ] V1.4: bridge, chrome, dev loop, home resolution, and one-OS UI boot.
- [ ] Record the V1b decision; implement only if evidence selects it.

## Wave 4

- [ ] V3a: remote CLI provenance pin and product version resolver.
- [ ] V3b: renderer product/compat/upstream version metadata.
- [ ] V1.5: resource staging, debug package, and smoke tests.

## Wave 5

- [ ] V1.6: three-OS hardening, CI, compatibility, and remote readiness.
- [ ] V2: Topology A measurements and hard criteria.
- [ ] V4-final: unsigned three-OS artifacts and payload validation.
- [ ] V5: final measurement and decision report.

## Final gate

- [ ] Focused tests, typechecks, Rust tests/clippy, and package smokes are green.
- [ ] Independent code review has no unresolved required findings.
- [ ] User-facing/internals documentation matches shipped Phase 0 behavior.
- [ ] All canonical Phase 0 acceptance criteria are evidenced.
