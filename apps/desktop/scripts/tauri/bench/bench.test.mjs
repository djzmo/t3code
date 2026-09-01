import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  captureMetadata,
  createResult,
  fixedWorkload,
  renderPairReport,
  renderReport,
  renderCompatibilityMarkdown,
  runCli,
  updateCompatibility,
  assertResult,
  validateResultPair,
  validateSignoffResult,
  validateResult,
} from "./index.mjs";
import {
  aggregateIdleRuns,
  aggregateProcessTreeSample,
  artifactIdentity,
  median,
  measurePathBytes,
  recordColdStartDurations,
  recordSizeMeasurement,
} from "./metrics.mjs";

const timedSamples = (rssBytes, cpuPercent, count = 31, spacingMs = 10_000) =>
  Array.from({ length: count }, (_, index) => ({
    rssBytes,
    cpuPercent,
    elapsedMs: index * spacingMs,
    timestamp:
      index % 2 === 0 ? new Date(Date.UTC(2026, 0, 1) + index * spacingMs).toISOString() : null,
  }));

function signedResult(runtime, overrides = {}) {
  const workload = fixedWorkload({
    config: { identity: "release-config", digest: "sha256:config" },
    databaseSeed: {
      method: "VACUUM INTO",
      source: "approved snapshot",
      snapshotIdentity: "seed-v1",
      digest: "sha256:seed",
    },
    ...overrides.workload,
  });
  const machine = {
    platform: "linux",
    arch: "x64",
    osRelease: "6.8.0",
    cpuModel: "fixture-cpu",
    cpuCount: 8,
  };
  const metadata = {
    ...captureMetadata({ runtime, platform: "linux", workload }),
    capturedAt: "2026-01-01T00:00:00.000Z",
    commit: { sha: "a".repeat(40), clean: true, dirty: false },
    artifact: {
      path: `/tmp/${runtime}.artifact`,
      name: `${runtime}.artifact`,
      bytes: runtime === "electron" ? 10 : 8,
      sha256: (runtime === "electron" ? "b" : "c").repeat(64),
    },
    machine,
    config: workload.config,
    seed: workload.databaseSeed,
    branding: workload.branding,
    workload,
    ...overrides.metadata,
  };
  const result = createResult({ runtime, platform: "linux", workload, metadata });
  const installerArtifact = {
    path: `/tmp/${runtime}-installer.artifact`,
    name: `${runtime}-installer.artifact`,
    bytes: metadata.artifact.bytes,
    sha256: (runtime === "electron" ? "d" : "e").repeat(64),
  };
  const installedArtifact = {
    path: `/tmp/${runtime}-installed`,
    name: `${runtime}-installed`,
    bytes: metadata.artifact.bytes * 2,
    sha256: (runtime === "electron" ? "f" : "1").repeat(64),
  };
  const idle = aggregateIdleRuns([
    { runId: "a", samples: timedSamples(100, 1) },
    { runId: "b", samples: timedSamples(120, 2) },
    { runId: "c", samples: timedSamples(140, 3) },
  ]);
  return {
    ...result,
    status: "pass",
    metrics: {
      sizes: {
        installerBytes: installerArtifact.bytes,
        installedBytes: installedArtifact.bytes,
        installerArtifact,
        installedArtifact,
        measuredAt: "2026-01-01T00:00:00.000Z",
      },
      idle,
      coldStart: recordColdStartDurations([100, 105, 95, 110, 90], {
        measuredAt: "2026-01-01T00:00:00.000Z",
      }),
    },
  };
}

describe("V0 benchmark harness", () => {
  it("creates a pending, schema-valid result with the fixed workload", () => {
    const result = createResult({
      runtime: "electron",
      platform: "linux",
      workload: fixedWorkload(),
    });
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.metrics.sizes.installerBytes, null);
    assert.equal(result.metrics.idle, null);
    assert.equal(result.metrics.coldStart, null);
    assert.equal(result.workload.projectCount, 1);
    assert.equal(result.workload.idleThreadCount, 1);
    assert.equal(result.protocol.idleSampleIntervalSeconds, 10);
    assert.equal(result.protocol.idleDurationSeconds, 300);
  });

  it("sums only the root process tree and ignores unrelated processes", () => {
    const sample = aggregateProcessTreeSample({
      rootPid: 100,
      processes: [
        { pid: 100, parentPid: 1, rssBytes: 10, cpuPercent: 1 },
        { pid: 101, parentPid: 100, rssBytes: 20, cpuPercent: 2 },
        { pid: 102, parentPid: 101, rssBytes: 30, cpuPercent: 3 },
        { pid: 999, parentPid: 1, rssBytes: 1_000, cpuPercent: 99 },
      ],
    });
    assert.deepEqual(sample.pids, [100, 101, 102]);
    assert.equal(sample.rssBytes, 60);
    assert.equal(sample.cpuPercent, 6);
  });

  it("uses a median of per-run medians for idle RSS and CPU", () => {
    const samples = (rssBytes, cpuPercent) => timedSamples(rssBytes, cpuPercent);
    const metric = aggregateIdleRuns([
      { runId: "a", samples: samples(100, 1) },
      { runId: "b", samples: samples(130, 3) },
      { runId: "c", samples: samples(150, 5) },
    ]);
    assert.equal(metric.aggregate.rssBytes, 130);
    assert.equal(metric.aggregate.cpuPercent, 3);
    assert.equal(metric.aggregate.method, "median-of-medians");
    assert.throws(() => aggregateIdleRuns([]), /at least 3 runs/);
    assert.throws(
      () =>
        aggregateIdleRuns([
          { samples: timedSamples(1, 1, 30) },
          { samples: samples(1, 1) },
          { samples: samples(1, 1) },
        ]),
      /at least 31 samples/,
    );
    assert.throws(
      () =>
        aggregateIdleRuns([
          { samples: timedSamples(1, 1, 31, 9_000) },
          { samples: samples(1, 1) },
          { samples: samples(1, 1) },
        ]),
      /expected 10s/,
    );
    assert.throws(
      () =>
        aggregateIdleRuns([
          {
            samples: timedSamples(1, 1, 31, 10_000).map((sample, index) => ({
              ...sample,
              elapsedMs: index === 3 ? 20_000 : sample.elapsedMs,
            })),
          },
          { samples: samples(1, 1) },
          { samples: samples(1, 1) },
        ]),
      /strictly increasing|expected 10s/,
    );
    assert.throws(
      () =>
        aggregateIdleRuns([
          {
            samples: timedSamples(1, 1).map((sample, index) => ({
              ...sample,
              elapsedMs: index === 3 ? "30000" : sample.elapsedMs,
            })),
          },
          { samples: samples(1, 1) },
          { samples: samples(1, 1) },
        ]),
      /numeric elapsedMs/,
    );
    assert.throws(
      () =>
        aggregateIdleRuns([
          { samples: timedSamples(1, 1, 31, 9_990) },
          { samples: samples(1, 1) },
          { samples: samples(1, 1) },
        ]),
      /requires at least 300s/,
    );
    assert.equal(median([3, 1, 2, 4]), 2.5);
  });

  it("records recursive installed bytes and a five-launch cold-start median", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-v0-bench-"));
    try {
      fs.mkdirSync(path.join(fixture, "nested"));
      fs.writeFileSync(path.join(fixture, "a.bin"), Buffer.alloc(4));
      fs.writeFileSync(path.join(fixture, "nested", "b.bin"), Buffer.alloc(6));
      assert.equal(measurePathBytes(fixture), 10);
      const size = recordSizeMeasurement({
        installedPath: fixture,
        measuredAt: "2026-01-01T00:00:00.000Z",
      });
      assert.equal(size.installedBytes, 10);
      assert.equal(size.installerBytes, null);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }

    const coldStart = recordColdStartDurations([120, 80, 100, 140, 90], {
      measuredAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(coldStart.launchCount, 5);
    assert.equal(coldStart.medianMs, 100);
  });

  it("records a deterministic artifact identity without launching anything", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-v0-artifact-"));
    try {
      fs.writeFileSync(path.join(fixture, "payload.bin"), Buffer.from("payload"));
      const identity = artifactIdentity(fixture);
      assert.equal(identity.path, path.resolve(fixture));
      assert.equal(identity.name, path.basename(fixture));
      assert.equal(identity.bytes, 7);
      assert.match(identity.sha256, /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("requires provenance before a result can be paired for sign-off", () => {
    const pending = createResult({ runtime: "electron", platform: "linux" });
    assert.notDeepEqual(validateSignoffResult(pending), []);
    assert.include(renderReport(pending), "DRAFT / PROVISIONAL");
    assert.throws(
      () => renderPairReport(pending, pending),
      /Invalid Electron\/Tauri benchmark pair/,
    );
  });

  it("requires complete measurements and concrete config and seed identities", () => {
    const cases = [
      [
        "installer size",
        (result) => ({
          ...result,
          metrics: { ...result.metrics, sizes: { ...result.metrics.sizes, installerBytes: null } },
        }),
      ],
      [
        "installed size",
        (result) => ({
          ...result,
          metrics: { ...result.metrics, sizes: { ...result.metrics.sizes, installedBytes: null } },
        }),
      ],
      ["idle", (result) => ({ ...result, metrics: { ...result.metrics, idle: null } })],
      [
        "idle aggregate",
        (result) => ({
          ...result,
          metrics: {
            ...result.metrics,
            idle: {
              ...result.metrics.idle,
              aggregate: { ...result.metrics.idle.aggregate, rssBytes: 1 },
            },
          },
        }),
      ],
      ["cold start", (result) => ({ ...result, metrics: { ...result.metrics, coldStart: null } })],
      [
        "five cold starts",
        (result) => ({
          ...result,
          metrics: {
            ...result.metrics,
            coldStart: {
              ...result.metrics.coldStart,
              launchCount: 4,
              launches: result.metrics.coldStart.launches.slice(0, 4),
            },
          },
        }),
      ],
      [
        "config identity",
        (result) => ({ ...result, metadata: { ...result.metadata, config: {} } }),
      ],
      ["completed status", (result) => ({ ...result, status: "pending" })],
      [
        "canonical workload",
        (result) => {
          const workload = { ...result.workload, projectCount: 2 };
          return { ...result, workload, metadata: { ...result.metadata, workload } };
        },
      ],
      [
        "seeded workload",
        (result) => {
          const workload = { ...result.workload, seededDatabase: false };
          return { ...result, workload, metadata: { ...result.metadata, workload } };
        },
      ],
      [
        "VACUUM INTO seed",
        (result) => {
          const seed = { ...result.workload.databaseSeed, method: "copy" };
          const workload = { ...result.workload, databaseSeed: seed };
          return {
            ...result,
            workload,
            metadata: { ...result.metadata, seed, workload },
          };
        },
      ],
      [
        "installer artifact provenance",
        (result) => ({
          ...result,
          metrics: {
            ...result.metrics,
            sizes: { ...result.metrics.sizes, installerArtifact: null },
          },
        }),
      ],
      [
        "installed artifact byte binding",
        (result) => ({
          ...result,
          metrics: {
            ...result.metrics,
            sizes: {
              ...result.metrics.sizes,
              installedArtifact: { ...result.metrics.sizes.installedArtifact, bytes: 999 },
            },
          },
        }),
      ],
      [
        "seed identity",
        (result) => ({
          ...result,
          metadata: {
            ...result.metadata,
            seed: { method: "VACUUM INTO", source: "approved snapshot" },
          },
        }),
      ],
    ];
    for (const [label, mutate] of cases)
      assert.notDeepEqual(validateSignoffResult(mutate(signedResult("electron"))), [], label);
    assert.deepEqual(validateSignoffResult(signedResult("electron")), []);
    assert.notInclude(renderReport(signedResult("electron")), "DRAFT / PROVISIONAL");
  });

  it("rejects every mismatched pair identity field", () => {
    const fields = [
      [
        "commit",
        (result) => ({
          ...result,
          metadata: {
            ...result.metadata,
            commit: { ...result.metadata.commit, sha: "d".repeat(40) },
          },
        }),
      ],
      [
        "machine",
        (result) => ({
          ...result,
          metadata: {
            ...result.metadata,
            machine: { ...result.metadata.machine, cpuCount: 16 },
          },
        }),
      ],
      [
        "config",
        (result) => {
          const config = { identity: "debug-config", digest: "sha256:debug" };
          const workload = { ...result.workload, config };
          return { ...result, workload, metadata: { ...result.metadata, config, workload } };
        },
      ],
      [
        "seed",
        (result) => {
          const seed = { ...result.metadata.seed, digest: "sha256:other-seed" };
          const workload = { ...result.workload, databaseSeed: seed };
          return { ...result, workload, metadata: { ...result.metadata, seed, workload } };
        },
      ],
      [
        "branding",
        (result) => {
          const branding = "other branding";
          const workload = { ...result.workload, branding };
          return { ...result, workload, metadata: { ...result.metadata, branding, workload } };
        },
      ],
      [
        "workload",
        (result) => {
          const workload = { ...result.workload, measurementIdentity: "other" };
          return { ...result, workload, metadata: { ...result.metadata, workload } };
        },
      ],
    ];
    for (const [field, mutate] of fields) {
      const electron = signedResult("electron");
      const tauri = mutate(signedResult("tauri"));
      assert.include(validateResultPair(electron, tauri).join("\n"), ` ${field} must match`);
    }
    const electron = signedResult("electron");
    const tauri = signedResult("tauri");
    assert.deepEqual(validateResultPair(electron, tauri), []);
    const report = renderPairReport(electron, tauri);
    assert.include(report, "Electron/Tauri desktop benchmark pair");
    assert.include(report, "Complete V0 comparative measurement");
    assert.notInclude(report, "still requires a validated Electron/Tauri pair");
  });

  it("does not write a comparative CLI report for an invalid pair", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-v0-pair-"));
    try {
      const electronPath = path.join(fixture, "electron.json");
      const tauriPath = path.join(fixture, "tauri.json");
      const outputPath = path.join(fixture, "pair.md");
      fs.writeFileSync(electronPath, JSON.stringify(signedResult("electron")));
      const tauri = signedResult("tauri");
      fs.writeFileSync(
        tauriPath,
        JSON.stringify({
          ...tauri,
          metadata: {
            ...tauri.metadata,
            commit: { ...tauri.metadata.commit, sha: "d".repeat(40) },
          },
        }),
      );
      assert.throws(
        () =>
          runCli([
            "report",
            "--electron",
            electronPath,
            "--tauri",
            tauriPath,
            "--output",
            outputPath,
          ]),
        /commit must match/,
      );
      assert.isFalse(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps WebKit checks pending until manual evidence is supplied", () => {
    const result = createResult();
    const updated = updateCompatibility(result.compatibility, {
      target: "webview2",
      check: "launch",
      status: "pass",
      notes: "fixture-only update",
      evidence: "fixture",
    });
    assert.equal(updated.webview2.status, "pending");
    assert.include(renderCompatibilityMarkdown(updated), "wkwebview");
    assert.include(renderCompatibilityMarkdown(updated), "pending");
    assert.doesNotThrow(() => assertResult({ ...result, compatibility: updated }));
  });
});
