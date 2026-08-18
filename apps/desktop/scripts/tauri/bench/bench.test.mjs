import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  createResult,
  fixedWorkload,
  renderCompatibilityMarkdown,
  updateCompatibility,
  assertResult,
  validateResult,
} from "./index.mjs";
import {
  aggregateIdleRuns,
  aggregateProcessTreeSample,
  median,
  measurePathBytes,
  recordColdStartDurations,
  recordSizeMeasurement,
} from "./metrics.mjs";

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
    const samples = (rssBytes, cpuPercent) =>
      Array.from({ length: 30 }, () => ({ rssBytes, cpuPercent }));
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
          { samples: Array.from({ length: 29 }, () => ({ rssBytes: 1, cpuPercent: 1 })) },
          { samples: samples(1, 1) },
          { samples: samples(1, 1) },
        ]),
      /at least 30 samples/,
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
