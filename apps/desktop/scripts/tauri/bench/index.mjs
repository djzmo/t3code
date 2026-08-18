#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  aggregateIdleRuns,
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
} = {}) {
  const cpus = os.cpus();
  return {
    capturedAt: new Date().toISOString(),
    runtime,
    platform,
    arch: process.arch,
    nodeVersion: process.version,
    commit: { sha: commit, dirty: null },
    build: { label, artifactPath: null, installerPath: null, installedPath: null },
    machine: { osRelease: os.release(), cpuModel: cpus[0]?.model ?? null, cpuCount: cpus.length },
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
  return {
    schemaVersion: 1,
    status: "pending",
    runtime,
    platform,
    metadata: metadata ?? captureMetadata({ runtime, platform }),
    workload: workload ?? fixedWorkload(),
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

export function validateResult(result) {
  const errors = [];
  if (!isRecord(result)) return ["result must be an object"];
  if (result.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!["electron", "tauri"].includes(result.runtime))
    errors.push("runtime must be electron or tauri");
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
    errors.push("metrics.idle must contain ≥3 runs using the 10-second/5-minute protocol");
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
  return [
    "# Desktop shell benchmark",
    "",
    "> V0 is informational. Values remain **pending approved execution** until artifact/installer launches are authorized.",
    "",
    `- Runtime: ${result.runtime}`,
    `- Platform: ${result.platform}`,
    `- Commit: ${metadata.commit?.sha ?? "pending"}`,
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
    writeResult(file, {
      ...result,
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
    const report = renderReport(readResult(required(parsed, "result")));
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
