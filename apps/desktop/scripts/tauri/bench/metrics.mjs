import fs from "node:fs";
import path from "node:path";

export function median(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(Number(value)))
  ) {
    throw new Error("median requires finite values");
  }
  const sorted = values.map(Number).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function processTreePids(rootPid, processes) {
  const root = Number(rootPid);
  if (!Number.isSafeInteger(root) || root <= 0 || !Array.isArray(processes))
    throw new Error("invalid process tree snapshot");
  const byPid = new Map(
    processes
      .filter((item) => item && Number.isSafeInteger(Number(item.pid)))
      .map((item) => [Number(item.pid), item]),
  );
  const pids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of byPid.values()) {
      const parent = process.parentPid ?? process.ppid;
      if (parent !== undefined && pids.has(Number(parent)) && !pids.has(Number(process.pid))) {
        pids.add(Number(process.pid));
        changed = true;
      }
    }
  }
  return [...pids].sort((a, b) => a - b);
}

export function aggregateProcessTreeSample({
  rootPid,
  processes,
  elapsedMs = null,
  timestamp = null,
} = {}) {
  const pids = processTreePids(rootPid, processes);
  const byPid = new Map(
    processes
      .filter((item) => item && Number.isSafeInteger(Number(item.pid)))
      .map((item) => [Number(item.pid), item]),
  );
  let rssBytes = 0;
  let cpuPercent = 0;
  for (const pid of pids) {
    const process = byPid.get(pid);
    if (!process) continue;
    const rss = Number(
      process.rssBytes ?? (process.rssKb === undefined ? 0 : Number(process.rssKb) * 1024),
    );
    const cpu = Number(process.cpuPercent ?? process.cpu ?? 0);
    if (!Number.isFinite(rss) || rss < 0 || !Number.isFinite(cpu) || cpu < 0)
      throw new Error(`invalid metrics for pid ${pid}`);
    rssBytes += rss;
    cpuPercent += cpu;
  }
  return {
    elapsedMs,
    timestamp,
    pids,
    processCount: pids.filter((pid) => byPid.has(pid)).length,
    rssBytes,
    cpuPercent,
  };
}

function normaliseSample(sample) {
  if (Array.isArray(sample?.processes)) return aggregateProcessTreeSample(sample);
  const rssBytes = Number(
    sample?.rssBytes ?? (sample?.rssKb === undefined ? NaN : Number(sample.rssKb) * 1024),
  );
  const cpuPercent = Number(sample?.cpuPercent ?? sample?.cpu ?? NaN);
  if (!Number.isFinite(rssBytes) || rssBytes < 0 || !Number.isFinite(cpuPercent) || cpuPercent < 0)
    throw new Error("invalid idle sample");
  return {
    elapsedMs: sample.elapsedMs ?? null,
    timestamp: sample.timestamp ?? null,
    pids: sample.pids ?? [],
    processCount: sample.processCount ?? null,
    rssBytes,
    cpuPercent,
  };
}

export function aggregateIdleRuns(
  runs,
  { sampleIntervalSeconds = 10, durationSeconds = 300, minimumRuns = 3 } = {},
) {
  if (!Array.isArray(runs) || runs.length < minimumRuns)
    throw new Error(`idle RSS/CPU requires at least ${minimumRuns} runs`);
  if (sampleIntervalSeconds !== 10 || durationSeconds !== 300)
    throw new Error("V0 idle protocol is fixed at 10-second samples over 5 minutes");
  const reduced = runs.map((run, index) => {
    if (!Array.isArray(run?.samples) || run.samples.length < 30)
      throw new Error(`idle run ${index + 1} requires at least 30 samples`);
    const samples = run.samples.map(normaliseSample);
    return {
      runId: run.runId ?? `run-${index + 1}`,
      startedAt: run.startedAt ?? null,
      samples,
      rssMedianBytes: median(samples.map((sample) => sample.rssBytes)),
      cpuMedianPercent: median(samples.map((sample) => sample.cpuPercent)),
    };
  });
  return {
    sampleIntervalSeconds,
    durationSeconds,
    minimumRuns,
    expectedSamplesPerRun: durationSeconds / sampleIntervalSeconds,
    runs: reduced,
    aggregate: {
      rssBytes: median(reduced.map((run) => run.rssMedianBytes)),
      cpuPercent: median(reduced.map((run) => run.cpuMedianPercent)),
      method: "median-of-medians",
    },
  };
}

/** Recursive payload bytes; directory symlinks are counted but never followed. */
export function measurePathBytes(targetPath) {
  const pending = [path.resolve(targetPath)];
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory()) {
      bytes += stat.size;
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(child);
      else bytes += fs.lstatSync(child).size;
    }
  }
  return bytes;
}

export function recordSizeMeasurement({
  installerPath = null,
  installedPath = null,
  measuredAt = new Date().toISOString(),
} = {}) {
  if (installerPath === null && installedPath === null)
    throw new Error("provide installerPath or installedPath");
  return {
    installerBytes: installerPath === null ? null : measurePathBytes(installerPath),
    installedBytes: installedPath === null ? null : measurePathBytes(installedPath),
    measuredAt,
  };
}

export function recordColdStartDurations(
  durations,
  { measuredAt = new Date().toISOString() } = {},
) {
  if (!Array.isArray(durations) || durations.length !== 5)
    throw new Error("cold start requires exactly 5 launches");
  const launches = durations.map((entry, index) => {
    const durationMs = Number(typeof entry === "number" ? entry : entry?.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new Error(`invalid duration for launch ${index + 1}`);
    return typeof entry === "number"
      ? { launch: index + 1, durationMs }
      : {
          launch: entry.launch ?? index + 1,
          durationMs,
          startedAt: entry.startedAt ?? null,
          readyAt: entry.readyAt ?? null,
        };
  });
  return {
    launchCount: 5,
    launches,
    medianMs: median(launches.map((launch) => launch.durationMs)),
    measuredAt,
    method: "median-of-5 launch-to-backend-ready durations",
  };
}

export function parseDurationList(value) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("durations must be comma-separated");
  return value.split(",").map((item) => {
    const duration = Number(item.trim());
    if (!Number.isFinite(duration) || duration < 0) throw new Error(`invalid duration: ${item}`);
    return duration;
  });
}
