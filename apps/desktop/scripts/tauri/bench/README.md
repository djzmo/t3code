# V0 desktop benchmark harness

This directory contains observation-only helpers for the Electron baseline in
the rev-26 plan. The harness does not launch Electron, Tauri, a browser, a
dev server, an installer, or a packaged application. An owner-approved run
collects observations externally and feeds them to these deterministic
recorders.

## Protocol

- Build Electron and Tauri from the same commit, with the same configuration,
  seeded database, branding, machine, and fixed workload (one project, one
  idle thread, terminal open).
- Record installer and installed payload sizes once per artifact.
- Capture process-tree RSS and idle CPU every 10 seconds for five minutes. Do
  at least three runs. Reduce each run to a median, then reduce those medians
  to the reported median-of-medians.
- Record five cold launches from process start to backend-ready and report the
  median.
- Complete the WKWebView, WebKitGTK, and WebView2 checklist manually. Include
  one packaged AppImage launch on a newer Wayland distribution in the WebKitGTK
  evidence.

## Commands

```text
node apps/desktop/scripts/tauri/bench/index.mjs init \
  --runtime electron --platform win32 --output electron-win32.json
node apps/desktop/scripts/tauri/bench/index.mjs sizes \
  --result electron-win32.json --installer <installer> --installed <install-dir>
node apps/desktop/scripts/tauri/bench/index.mjs idle \
  --result electron-win32.json --runs idle-runs.json
node apps/desktop/scripts/tauri/bench/index.mjs cold-start \
  --result electron-win32.json --durations 120,125,118,121,123
node apps/desktop/scripts/tauri/bench/index.mjs report \
  --result electron-win32.json --output electron-win32.md
```

`idle-runs.json` is either an array of runs or `{ "runs": [...] }`. A run has
`samples`; each sample may be an already aggregated `{rssBytes,cpuPercent}`
record or a `{rootPid,processes}` snapshot. Process records use `pid`,
`parentPid` (or `ppid`), `rssBytes` (or `rssKb`), and `cpuPercent` (or `cpu`).

Every newly created result and checklist starts with `pending` values. Do not
replace those values with guessed or local-machine numbers; the baseline is
filled only during the approved execution checkpoint.

## Topology A bridge benchmark

`topology-a-runner.mjs` drives the real renderer → native → host path through
Tauri Pilot. Pilot is compiled only for an explicit debug benchmark build;
ordinary debug and release builds exclude the plugin and Tauri's `unstable`
feature. The runner-owned app receives `AGENT_NANONI_TOPOLOGY_A_BENCH=1`, and
the development launcher adds the temporary `pilot:default` capability only
for that run.

Install and verify the exact CLI used by the matching Rust plugin:

```text
cargo install tauri-pilot-cli --version 0.7.2 --locked
tauri-pilot --version
```

With the repository Node 24 runtime active, run one result per system WebView:

```text
node apps/desktop/scripts/tauri/bench/topology-a-runner.mjs --output topology-a-win32.json --app node -- scripts/dev-runner.ts dev:tauri
```

The runner waits for Pilot before each evaluation, records 1,000 round trips,
100 renderer-scheduled pushes, an exact 1 MiB echo, reload sync stability, and
failure cases, then writes one deterministic JSON result. It terminates only
the app PID/process group captured from its own spawn. A run is not evidence
until the JSON reports `pass: true` and its measured values are copied into the
Phase 0 report.
When attaching to an already-running app instead of using `--app`, the caller
must have launched `dev:tauri` with the benchmark flag already set.
