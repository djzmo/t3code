# Phase 1 plan (starts after the Phase 0 owner-gate PR)

Canonical table: frozen plan §7. V1b was not selected, so F9 is N/A.
T3 Connect (F11) needs an owner pre-spike decision — skip and document the
gap unless that decision already exists.

## Wave A — can start on Windows immediately (parallel)

| ID                  | Worker files                                                                                          | Do not touch                          |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| F1                  | `src-tauri/src/{dialog,opener,theme}.rs`, `src/tauri/electron/{TauriDialog,TauriShell,TauriTheme}.ts` | menu.rs, secure_storage.rs            |
| F2 (a0 spike first) | `src-tauri/src/menu.rs`, `src/tauri/electron/TauriMenu.ts`                                            | dialog.rs                             |
| F8 (a spike first)  | `src-tauri/src/power.rs`, `src/tauri/electron/TauriPowerMonitor.ts`                                   | F8(b) until spike records a mechanism |

## Wave B — after V1.6 / 3-OS (environment-blocked here)

F3 (window matrix), F5 (deep links; before F4).

## Wave C — after V4-final

F6 (WSL), F7 (updates). Then F10 docs, then K1→K2→K3 (signing secrets are ⛔ skip).

## Skipped without owner

- F11 / Connect evaluate vs defer
- K1 signing secrets, K3 first nightly/stable, OS-minimum hardware
- 3-OS acceptance for every slice; Windows evidence first, record the rest
