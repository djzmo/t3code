#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  aggregateIdleRuns,
  artifactIdentity,
  parseDurationList,
  recordColdStartDurations,
  recordSizeMeasurement,
} from "./metrics.mjs";

export const PROTOCOL = Object.freeze({
  idleSampleIntervalSeconds: 10,
  idleDurationSeconds: 300,
  idleMinimumRuns: 3,
  coldStartLaunches: 5,
});
export const WEBVIEWS = Object.freeze(["wkwebview", "webkitgtk", "webview2"]);
export const CHECKS = Object.freeze([
  "launch",
  "core-ui",
  "terminal",
  "diff-panel",
  "drag-and-drop",
  "clipboard-paste",
  "popovers",
  "fonts",
  "websocket-reconnect",
]);
const STATUSES = new Set(["pending", "pass", "blocked", "not-run"]);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

function normaliseCommit(commit, clean = null) {
  if (isRecord(commit)) {
    const resolvedClean =
      typeof clean === "boolean"
        ? clean
        : typeof commit.clean === "boolean"
          ? commit.clean
          : typeof commit.dirty === "boolean"
            ? !commit.dirty
            : null;
    return {
      sha: commit.sha ?? null,
      clean: resolvedClean,
      dirty: resolvedClean === null ? (commit.dirty ?? null) : !resolvedClean,
    };
  }
  return {
    sha: commit ?? null,
    clean,
    dirty: clean === null ? null : !clean,
  };
}

function defaultSeed() {
  return { method: "VACUUM INTO", source: "approved snapshot", sourcePath: null };
}

export function pendingCompatibility() {
  return Object.fromEntries(
    WEBVIEWS.map((target) => [
      target,
      {
        status: "pending",
        evidence: null,
        checks: Object.fromEntries(
          CHECKS.map((check) => [check, { status: "pending", notes: null }]),
        ),
      },
    ]),
  );
}

export function captureMetadata({
  runtime = "electron",
  platform = process.platform,
  label = null,
  commit = process.env.GIT_COMMIT ?? null,
  clean = null,
  artifact = null,
  config = {},
  seed = defaultSeed(),
  branding = "same branding for Electron and Tauri",
  workload = null,
} = {}) {
  const cpus = os.cpus();
  const commitMetadata = normaliseCommit(commit, clean);
  const machine = {
    platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
  };
  return {
    capturedAt: new Date().toISOString(),
    runtime,
    platform,
    arch: process.arch,
    nodeVersion: process.version,
    commit: commitMetadata,
    artifact: clone(artifact),
    config: clone(config),
    seed: clone(seed),
    branding,
    workload: clone(workload),
    build: {
      label,
      artifactPath: artifact?.path ?? null,
      installerPath: null,
      installedPath: null,
      artifact: clone(artifact),
      installerArtifact: null,
      installedArtifact: null,
    },
    machine,
  };
}

export function fixedWorkload(overrides = {}) {
  return {
    projectCount: 1,
    idleThreadCount: 1,
    terminalOpen: true,
    idleDurationSeconds: PROTOCOL.idleDurationSeconds,
    seededDatabase: true,
    databaseSeed: { method: "VACUUM INTO", source: "approved snapshot", sourcePath: null },
    branding: "same branding for Electron and Tauri",
    config: {},
    ...overrides,
  };
}

export function createResult({
  runtime = "electron",
  platform = process.platform,
  metadata,
  workload,
  compatibility,
} = {}) {
  if (!runtime || !["electron", "tauri"].includes(runtime))
    throw new Error(`Unsupported runtime: ${runtime}`);
  const resolvedWorkload = workload ?? fixedWorkload();
  return {
    schemaVersion: 1,
    status: "pending",
    runtime,
    platform,
    metadata:
      metadata ??
      captureMetadata({
        runtime,
        platform,
        config: resolvedWorkload.config ?? {},
        seed: resolvedWorkload.databaseSeed ?? defaultSeed(),
        branding: resolvedWorkload.branding,
        workload: resolvedWorkload,
      }),
    workload: resolvedWorkload,
    protocol: { ...PROTOCOL },
    metrics: {
      sizes: { installerBytes: null, installedBytes: null, measuredAt: null },
      idle: null,
      coldStart: null,
    },
    compatibility: compatibility ?? pendingCompatibility(),
    notes: [],
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function artifactFromMetadata(metadata) {
  return metadata?.artifact ?? metadata?.build?.artifact ?? null;
}

function identityParts(result) {
  const metadata = result?.metadata ?? {};
  const workload = result?.workload ?? metadata.workload ?? null;
  return {
    commit: typeof metadata.commit?.sha === "string" ? metadata.commit.sha.toLowerCase() : null,
    machine: metadata.machine ?? null,
    config: metadata.config ?? workload?.config ?? null,
    seed: metadata.seed ?? workload?.databaseSeed ?? null,
    branding: metadata.branding ?? workload?.branding ?? null,
    workload,
  };
}

function hasConcreteIdentity(value) {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return ["identity", "digest", "sha256", "snapshotIdentity"].some(
    (key) => typeof value[key] === "string" && value[key].trim().length > 0,
  );
}

function validateArtifact(value, label = "artifact") {
  const errors = [];
  if (!isRecord(value)) return [`${label} is required for sign-off`];
  if (typeof value.path !== "string" || value.path.length === 0)
    errors.push(`${label}.path must be a non-empty string`);
  if (typeof value.name !== "string" || value.name.length === 0)
    errors.push(`${label}.name must be a non-empty string`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0)
    errors.push(`${label}.bytes must be a non-negative safe integer`);
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256))
    errors.push(`${label}.sha256 must be a full 64-hex digest`);
  return errors;
}

function validateCompletedMetrics(result) {
  const errors = [];
  const sizes = result?.metrics?.sizes;
  for (const key of ["installerBytes", "installedBytes"])
    if (!Number.isSafeInteger(sizes?.[key]) || sizes[key] < 0)
      errors.push(`metrics.sizes.${key} is required for sign-off`);
  for (const [artifactKey, sizeKey] of [
    ["installerArtifact", "installerBytes"],
    ["installedArtifact", "installedBytes"],
  ]) {
    const artifact = sizes?.[artifactKey];
    errors.push(...validateArtifact(artifact, `metrics.sizes.${artifactKey}`));
    if (isRecord(artifact) && artifact.bytes !== sizes?.[sizeKey])
      errors.push(`metrics.sizes.${artifactKey}.bytes must match metrics.sizes.${sizeKey}`);
  }

  const idle = result?.metrics?.idle;
  if (!isRecord(idle)) errors.push("metrics.idle is required for sign-off");
  else {
    try {
      const recomputed = aggregateIdleRuns(idle.runs, {
        sampleIntervalSeconds: idle.sampleIntervalSeconds,
        durationSeconds: idle.durationSeconds,
        minimumRuns: 3,
        sampleIntervalToleranceSeconds: idle.sampleIntervalToleranceSeconds ?? 0.5,
      });
      for (const key of ["rssBytes", "cpuPercent", "method"])
        if (idle.aggregate?.[key] !== recomputed.aggregate[key])
          errors.push(`metrics.idle.aggregate.${key} does not match the qualifying runs`);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `metrics.idle is not a qualifying sign-off measurement: ${error.message}`
          : "metrics.idle is not a qualifying sign-off measurement",
      );
    }
  }

  const coldStart = result?.metrics?.coldStart;
  if (!isRecord(coldStart) || !Array.isArray(coldStart.launches) || coldStart.launches.length !== 5)
    errors.push("metrics.coldStart must contain exactly five launches for sign-off");
  else {
    try {
      const recomputed = recordColdStartDurations(coldStart.launches, {
        measuredAt: coldStart.measuredAt,
      });
      if (coldStart.launchCount !== 5 || coldStart.medianMs !== recomputed.medianMs)
        errors.push("metrics.coldStart must contain a valid median of exactly five launches");
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `metrics.coldStart is invalid: ${error.message}`
          : "metrics.coldStart is invalid",
      );
    }
  }
  return errors;
}

function validateSignoffMetadata(result) {
  const errors = [];
  if (result?.status !== "pass" && result?.status !== "blocked")
    errors.push("status must be pass or blocked for sign-off");
  const metadata = result?.metadata;
  if (!isRecord(metadata)) return ["metadata is required for sign-off"];
  const commit = metadata.commit;
  if (!isRecord(commit) || typeof commit.sha !== "string" || !GIT_SHA_PATTERN.test(commit.sha))
    errors.push("metadata.commit.sha must be a full 40-hex git SHA");
  if (commit?.clean !== true) errors.push("metadata.commit.clean must be true for sign-off");
  errors.push(...validateArtifact(artifactFromMetadata(metadata), "metadata.artifact"));

  const identity = identityParts(result);
  const machine = identity.machine;
  if (!isRecord(machine)) errors.push("metadata.machine is required for sign-off");
  else {
    for (const key of ["platform", "arch", "osRelease", "cpuModel", "cpuCount"])
      if (machine[key] === undefined || machine[key] === null || machine[key] === "")
        errors.push(`metadata.machine.${key} is required for sign-off`);
  }
  if (!hasConcreteIdentity(identity.config))
    errors.push("metadata.config requires a concrete identity or digest for sign-off");
  if (!isRecord(identity.seed)) errors.push("metadata.seed is required for sign-off");
  else {
    for (const key of ["method", "source"])
      if (typeof identity.seed[key] !== "string" || identity.seed[key].length === 0)
        errors.push(`metadata.seed.${key} is required for sign-off`);
    if (!hasConcreteIdentity(identity.seed))
      errors.push("metadata.seed requires a concrete snapshot identity or digest for sign-off");
  }
  if (typeof identity.branding !== "string" || identity.branding.length === 0)
    errors.push("metadata.branding is required for sign-off");
  const workload = identity.workload;
  if (!isRecord(workload)) errors.push("workload is required for sign-off");
  else {
    for (const [key, expected] of [
      ["projectCount", 1],
      ["idleThreadCount", 1],
      ["terminalOpen", true],
      ["idleDurationSeconds", 300],
      ["seededDatabase", true],
    ])
      if (workload[key] !== expected)
        errors.push(`workload.${key} must be ${String(expected)} for sign-off`);
    if (workload.databaseSeed?.method !== "VACUUM INTO")
      errors.push('workload.databaseSeed.method must be "VACUUM INTO" for sign-off');
    for (const [metadataKey, workloadKey] of [
      ["config", "config"],
      ["seed", "databaseSeed"],
      ["branding", "branding"],
    ])
      if (stableSerialize(metadata[metadataKey]) !== stableSerialize(workload[workloadKey]))
        errors.push(`metadata.${metadataKey} must match workload.${workloadKey}`);
  }
  if (
    metadata.workload !== null &&
    metadata.workload !== undefined &&
    stableSerialize(metadata.workload) !== stableSerialize(result.workload)
  )
    errors.push("metadata.workload must match the recorded workload");
  errors.push(...validateCompletedMetrics(result));
  return errors;
}

export function validateSignoffResult(result) {
  const errors = validateResult(result);
  return [...errors, ...validateSignoffMetadata(result)];
}

export function assertSignoffResult(result) {
  const errors = validateSignoffResult(result);
  if (errors.length > 0)
    throw new Error(
      `Invalid benchmark sign-off:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  return result;
}

export function validateResultPair(electronResult, tauriResult) {
  const errors = [
    ...validateSignoffResult(electronResult).map((error) => `electron: ${error}`),
    ...validateSignoffResult(tauriResult).map((error) => `tauri: ${error}`),
  ];
  if (electronResult?.runtime !== "electron")
    errors.push("electron result must have runtime electron");
  if (tauriResult?.runtime !== "tauri") errors.push("tauri result must have runtime tauri");
  if (errors.length > 0) return errors;
  const electron = identityParts(electronResult);
  const tauri = identityParts(tauriResult);
  for (const key of ["commit", "machine", "config", "seed", "branding", "workload"])
    if (stableSerialize(electron[key]) !== stableSerialize(tauri[key]))
      errors.push(`electron and tauri ${key} must match`);
  return errors;
}

export function assertResultPair(electronResult, tauriResult) {
  const errors = validateResultPair(electronResult, tauriResult);
  if (errors.length > 0)
    throw new Error(
      `Invalid Electron/Tauri benchmark pair:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  return { electron: electronResult, tauri: tauriResult };
}

export function validateResult(result) {
  const errors = [];
  if (!isRecord(result)) return ["result must be an object"];
  if (result.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!["electron", "tauri"].includes(result.runtime))
    errors.push("runtime must be electron or tauri");
  if (!isRecord(result.metadata)) errors.push("metadata is required");
  if (!isRecord(result.workload)) errors.push("workload is required");
  if (
    !isRecord(result.protocol) ||
    Object.entries(PROTOCOL).some(([key, value]) => result.protocol[key] !== value)
  ) {
    errors.push("protocol must be the fixed V0 protocol");
  }
  if (!isRecord(result.metrics) || !isRecord(result.metrics.sizes))
    errors.push("metrics.sizes is required");
  else {
    for (const key of ["installerBytes", "installedBytes"]) {
      const value = result.metrics.sizes[key];
      if (!(value === null || (Number.isSafeInteger(value) && value >= 0)))
        errors.push(`metrics.sizes.${key} is invalid`);
    }
    if (
      !(
        result.metrics.sizes.measuredAt === null ||
        typeof result.metrics.sizes.measuredAt === "string"
      )
    )
      errors.push("metrics.sizes.measuredAt is invalid");
  }
  const idle = result.metrics?.idle;
  if (
    idle !== null &&
    (!isRecord(idle) ||
      idle.sampleIntervalSeconds !== 10 ||
      idle.durationSeconds !== 300 ||
      !Array.isArray(idle.runs) ||
      idle.runs.length < 3 ||
      !isRecord(idle.aggregate))
  ) {
    errors.push(
      "metrics.idle must contain ≥3 timestamped runs using the 10-second/5-minute protocol",
    );
  } else if (idle !== null) {
    const tolerance = idle.sampleIntervalToleranceSeconds ?? 0.5;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.5)
      errors.push("metrics.idle.sampleIntervalToleranceSeconds must be ≤0.5 seconds");
    try {
      aggregateIdleRuns(idle.runs, {
        sampleIntervalSeconds: idle.sampleIntervalSeconds,
        durationSeconds: idle.durationSeconds,
        minimumRuns: 3,
        sampleIntervalToleranceSeconds: tolerance,
      });
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `metrics.idle is invalid: ${error.message}`
          : "metrics.idle is invalid",
      );
    }
  }
  const cold = result.metrics?.coldStart;
  if (
    cold !== null &&
    (!isRecord(cold) ||
      cold.launchCount !== 5 ||
      cold.launches?.length !== 5 ||
      !Number.isFinite(cold.medianMs))
  ) {
    errors.push("metrics.coldStart must contain exactly five launches");
  }
  if (!isRecord(result.compatibility)) errors.push("compatibility is required");
  else {
    for (const target of WEBVIEWS) {
      const entry = result.compatibility[target];
      if (!isRecord(entry) || !STATUSES.has(entry.status) || !isRecord(entry.checks)) {
        errors.push(`compatibility.${target} is invalid`);
        continue;
      }
      for (const check of CHECKS)
        if (!STATUSES.has(entry.checks[check]?.status))
          errors.push(`compatibility.${target}.${check} is invalid`);
    }
  }
  return errors;
}

export function assertResult(result) {
  const errors = validateResult(result);
  if (errors.length > 0)
    throw new Error(`Invalid benchmark result:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return result;
}

function readResult(file) {
  return assertResult(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
}
function writeResult(file, result) {
  fs.writeFileSync(
    path.resolve(file),
    `${JSON.stringify(assertResult(result), null, 2)}\n`,
    "utf8",
  );
}
function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    parsed[key] = next && !next.startsWith("--") ? (index++, next) : true;
  }
  return parsed;
}
function required(parsed, key) {
  if (typeof parsed[key] !== "string" || parsed[key].length === 0)
    throw new Error(`Missing --${key}`);
  return parsed[key];
}

export function updateCompatibility(
  report,
  { target, check, status, notes = null, evidence = null } = {},
) {
  if (!WEBVIEWS.includes(target) || !CHECKS.includes(check) || !STATUSES.has(status))
    throw new Error("invalid compatibility update");
  const current = report[target] ?? pendingCompatibility()[target];
  const checks = { ...current.checks, [check]: { status, notes } };
  const statuses = Object.values(checks).map((item) => item.status);
  const overall = statuses.includes("blocked")
    ? "blocked"
    : statuses.every((item) => item === "pass")
      ? "pass"
      : "pending";
  return {
    ...report,
    [target]: { ...current, status: overall, evidence: evidence ?? current.evidence, checks },
  };
}

export function renderCompatibilityMarkdown(report) {
  const lines = ["| Webview | Overall | Evidence |", "| --- | --- | --- |"];
  for (const target of WEBVIEWS)
    lines.push(
      `| ${target} | ${report[target].status} | ${report[target].evidence ?? "pending approved execution"} |`,
    );
  lines.push("", "| Target | Check | Status | Notes |", "| --- | --- | --- | --- |");
  for (const target of WEBVIEWS)
    for (const check of CHECKS) {
      const item = report[target].checks[check];
      lines.push(`| ${target} | ${check} | ${item.status} | ${item.notes ?? ""} |`);
    }
  return `${lines.join("\n")}\n`;
}

export function renderReport(result) {
  assertResult(result);
  const { metadata, workload, metrics } = result;
  const complete = validateSignoffResult(result).length === 0;
  return [
    "# Desktop shell benchmark",
    "",
    complete
      ? "> Complete V0 measurement. Comparative sign-off still requires a validated Electron/Tauri pair."
      : "> **DRAFT / PROVISIONAL.** This standalone result is incomplete and cannot be used for Phase 0 sign-off.",
    "",
    `- Runtime: ${result.runtime}`,
    `- Platform: ${result.platform}`,
    `- Commit: ${metadata.commit?.sha ?? "pending"}`,
    `- Artifact: ${metadata.artifact?.name ?? metadata.build?.artifact?.name ?? "pending"}`,
    `- Captured: ${metadata.capturedAt ?? "pending"}`,
    "",
    "## Fixed workload",
    "",
    `- Projects: ${workload.projectCount}`,
    `- Idle threads: ${workload.idleThreadCount}`,
    `- Terminal open: ${workload.terminalOpen}`,
    `- Idle duration: ${workload.idleDurationSeconds} seconds`,
    `- Seeded database: ${workload.seededDatabase}`,
    "",
    "## Measurements",
    "",
    "| Metric | Value | Protocol |",
    "| --- | --- | --- |",
    `| Installer size | ${metrics.sizes.installerBytes ?? "pending"} bytes | one artifact measurement |`,
    `| Installed size | ${metrics.sizes.installedBytes ?? "pending"} bytes | recursive payload bytes |`,
    `| Idle RSS | ${metrics.idle?.aggregate?.rssBytes ?? "pending"} bytes | 10 s × 5 min; ≥3 run median-of-medians |`,
    `| Idle CPU | ${metrics.idle?.aggregate?.cpuPercent ?? "pending"} % | informational; same samples |`,
    `| Cold start | ${metrics.coldStart?.medianMs ?? "pending"} ms | median of 5 launches to backend ready |`,
    "",
    "## WebKit compatibility checklist",
    "",
    renderCompatibilityMarkdown(result.compatibility).trimEnd(),
    "",
    "No process, installer, browser, dev server, or packaged app was launched by this harness.",
    "",
  ].join("\n");
}

export function renderPairReport(electronResult, tauriResult) {
  assertResultPair(electronResult, tauriResult);
  const asPairSection = (result) =>
    renderReport(result).replace(/^# Desktop shell benchmark\n\n> [^\n]+\n\n/, "");
  return [
    "# Electron/Tauri desktop benchmark pair",
    "",
    "> Complete V0 comparative measurement with validated matching provenance.",
    "",
    `- Commit: ${electronResult.metadata.commit.sha}`,
    `- Machine: ${stableSerialize(identityParts(electronResult).machine)}`,
    "",
    "## Electron",
    "",
    asPairSection(electronResult),
    "## Tauri",
    "",
    asPairSection(tauriResult),
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)) {
  const parsed = options(argv);
  const command = parsed._[0] ?? "help";
  if (command === "help")
    return "V0 recorder: init | sizes | idle | cold-start | report (observation-only; never launches an app)";
  if (command === "init") {
    const output = required(parsed, "output");
    const runtime = parsed.runtime ?? "electron";
    const platform = parsed.platform ?? process.platform;
    const result = createResult({
      runtime,
      platform,
      metadata: captureMetadata({ runtime, platform, label: parsed.label ?? "V0 baseline" }),
    });
    writeResult(output, result);
    return result;
  }
  if (command === "sizes") {
    const file = required(parsed, "result");
    const measurement = recordSizeMeasurement({
      installerPath: parsed.installer ?? null,
      installedPath: parsed.installed ?? null,
    });
    const result = readResult(file);
    const installerArtifact = measurement.installerArtifact;
    const installedArtifact = measurement.installedArtifact;
    const selectedArtifact =
      (typeof parsed.artifact === "string" ? artifactIdentity(parsed.artifact) : null) ??
      installerArtifact ??
      installedArtifact ??
      result.metadata.artifact ??
      null;
    writeResult(file, {
      ...result,
      metadata: {
        ...result.metadata,
        artifact: selectedArtifact,
        build: {
          ...result.metadata.build,
          artifact: selectedArtifact,
          artifactPath: selectedArtifact?.path ?? result.metadata.build?.artifactPath ?? null,
          installerPath: installerArtifact?.path ?? result.metadata.build?.installerPath ?? null,
          installedPath: installedArtifact?.path ?? result.metadata.build?.installedPath ?? null,
          installerArtifact: installerArtifact ?? result.metadata.build?.installerArtifact ?? null,
          installedArtifact: installedArtifact ?? result.metadata.build?.installedArtifact ?? null,
        },
      },
      metrics: { ...result.metrics, sizes: { ...result.metrics.sizes, ...measurement } },
    });
    return measurement;
  }
  if (command === "idle") {
    const file = required(parsed, "result");
    const input = JSON.parse(fs.readFileSync(path.resolve(required(parsed, "runs")), "utf8"));
    const metric = aggregateIdleRuns(Array.isArray(input) ? input : input.runs);
    const result = readResult(file);
    writeResult(file, { ...result, metrics: { ...result.metrics, idle: metric } });
    return metric;
  }
  if (command === "cold-start") {
    const file = required(parsed, "result");
    const metric = recordColdStartDurations(parseDurationList(required(parsed, "durations")));
    const result = readResult(file);
    writeResult(file, { ...result, metrics: { ...result.metrics, coldStart: metric } });
    return metric;
  }
  if (command === "report") {
    const electronFile = parsed.electron;
    const tauriFile = parsed.tauri;
    if ((electronFile && !tauriFile) || (!electronFile && tauriFile))
      throw new Error("report pair requires both --electron and --tauri");
    const report =
      electronFile && tauriFile
        ? renderPairReport(readResult(electronFile), readResult(tauriFile))
        : renderReport(readResult(required(parsed, "result")));
    if (typeof parsed.output === "string")
      fs.writeFileSync(path.resolve(parsed.output), report, "utf8");
    return report;
  }
  throw new Error(`Unknown command: ${command}`);
}

const invoked =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const output = runCli();
    if (typeof output === "string") console.log(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
