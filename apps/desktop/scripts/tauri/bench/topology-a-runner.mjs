#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import { createRendererEvaluationSource, createRendererPostReloadSource } from "./topology-a.mjs";

export const TAURI_PILOT_VERSION = "0.7.2";
export const DEFAULT_PILOT_BINARY = "tauri-pilot";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_PING_INTERVAL_MS = 100;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const asOutput = (value) => {
  if (typeof value === "string") return { exitCode: 0, stdout: value, stderr: "" };
  if (!isRecord(value)) throw new TypeError("pilot command must return stdout and exitCode");
  return {
    exitCode: value.exitCode ?? value.code ?? 0,
    stdout: String(value.stdout ?? ""),
    stderr: String(value.stderr ?? ""),
  };
};

/**
 * Parse one complete `tauri-pilot --json` response.
 *
 * The CLI reserves stdout for the JSON value.  Do not search for a JSON line
 * inside logs: accepting a partial/noisy response can make a benchmark report
 * look valid while evaluating a different command result.
 */
export function parsePilotJsonOutput(output, label = "pilot command") {
  const text = String(output ?? "").trim();
  if (text.length === 0) throw new Error(`${label} returned no JSON output`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned non-JSON output: ${errorMessage(error)}`);
  }
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "error")) {
    const detail = isRecord(value.error) ? value.error.message : value.error;
    throw new Error(`${label} failed: ${String(detail ?? "unknown error")}`);
  }
  return value;
}

const runChild = (
  command,
  args,
  { cwd, env, input, timeoutMs, spawnProcess = NodeChildProcess.spawn } = {},
) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => finish({ exitCode, signal, stdout, stderr }));
    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });

/** Run a tauri-pilot command without a shell. */
export async function executePilotCommand({
  binary = DEFAULT_PILOT_BINARY,
  args,
  input,
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = NodeChildProcess.spawn,
} = {}) {
  if (typeof binary !== "string" || binary.length === 0)
    throw new TypeError("pilot binary required");
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("pilot args must be a string array");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("pilot command timeout must be positive");
  }
  const result = await runChild(binary, args, { cwd, env, input, timeoutMs, spawnProcess });
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`tauri-pilot ${args.join(" ")} failed: ${details}`);
  }
  return result;
}

export function buildPilotArgs({ socket, window, command, commandArgs = [] } = {}) {
  if (typeof command !== "string" || command.length === 0)
    throw new TypeError("pilot command required");
  if (!Array.isArray(commandArgs) || commandArgs.some((argument) => typeof argument !== "string")) {
    throw new TypeError("pilot command args must be a string array");
  }
  const args = [];
  if (socket !== undefined) {
    if (typeof socket !== "string" || socket.length === 0)
      throw new TypeError("pilot socket must be non-empty");
    args.push("--socket", socket);
  }
  if (window !== undefined) {
    if (typeof window !== "string" || window.length === 0)
      throw new TypeError("pilot window must be non-empty");
    args.push("--window", window);
  }
  return [...args, "--json", command, ...commandArgs];
}

export function validateTopologyABeforeResult(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.phase !== "before-reload") {
    throw new Error("pilot pre-reload result has an invalid Topology A schema or phase");
  }
  if (!isRecord(value.criteria) || !isRecord(value.reload) || value.reload.after !== null) {
    throw new Error("pilot pre-reload result is missing the before-reload snapshot");
  }
  return value;
}

export function validateTopologyACompleteResult(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.phase !== "complete") {
    throw new Error("pilot post-reload result has an invalid Topology A schema or phase");
  }
  if (!isRecord(value.criteria) || !isRecord(value.reload) || value.reload.after === null) {
    throw new Error("pilot post-reload result is missing the after-reload snapshot");
  }
  return value;
}

export function serializeTopologyAResult(result) {
  if (!isRecord(result)) throw new TypeError("Topology A result must be an object");
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function writeTopologyAResult(
  outputPath,
  result,
  { writeFile = NodeFS.writeFileSync } = {},
) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("Topology A output path is required");
  }
  const resolved = NodePath.resolve(outputPath);
  writeFile(resolved, serializeTopologyAResult(result), "utf8");
  return resolved;
}

export function spawnCapturedApplication(
  command,
  { cwd, env = process.env, spawnProcess = NodeChildProcess.spawn } = {},
) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string")
  ) {
    throw new TypeError("app command must be a non-empty string array");
  }
  const child = spawnProcess(command[0], command.slice(1), {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "ignore",
  });
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("app process did not expose a captured pid");
  return Object.freeze({ child, pid, groupId: process.platform === "win32" ? null : pid });
}

export function terminateCapturedApplication(
  captured,
  { terminate = terminateNativeProcess } = {},
) {
  if (!captured || !Number.isSafeInteger(captured.pid) || captured.pid <= 0) return;
  terminate(captured);
}

function terminateNativeProcess(captured) {
  if (process.platform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/pid", String(captured.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-(captured.groupId ?? captured.pid), "SIGTERM");
  } catch {
    try {
      process.kill(captured.pid, "SIGTERM");
    } catch {
      // The captured process may have exited during cleanup.
    }
  }
}

const monotonicNow = () => Date.now();

async function runPilot(options, specification) {
  const result = await options.runPilotCommand(specification);
  const output = asOutput(result);
  if (output.exitCode !== 0) {
    const details = output.stderr.trim() || output.stdout.trim() || `exit ${output.exitCode}`;
    throw new Error(`tauri-pilot ${specification.command} failed: ${details}`);
  }
  return output;
}

async function waitForPilotPing(options) {
  const startedAt = options.now();
  let lastError;
  while (options.now() - startedAt <= options.timeoutMs) {
    try {
      const output = await runPilot(options, options.makeSpecification("ping"));
      const value = parsePilotJsonOutput(output.stdout, "tauri-pilot ping");
      if (!isRecord(value)) throw new Error("tauri-pilot ping returned a non-object response");
      return value;
    } catch (error) {
      lastError = error;
    }
    await options.sleep(Math.min(options.pingIntervalMs, Math.max(options.timeoutMs, 1)));
  }
  throw new Error(`tauri-pilot ping did not become ready: ${errorMessage(lastError)}`);
}

/**
 * Run the Topology A measurement against an already-running Tauri app, or an
 * app command supplied by the caller.  The process and command boundaries are
 * injectable so unit tests never launch a GUI, server, or real CLI.
 */
export async function runTopologyAPilot({
  outputPath,
  appCommand,
  appCwd,
  appEnv = process.env,
  pilotBinary = DEFAULT_PILOT_BINARY,
  socket,
  window,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
  spawnProcess = NodeChildProcess.spawn,
  runPilotCommand,
  terminate = terminateNativeProcess,
  sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  now = monotonicNow,
  writeFile = NodeFS.writeFileSync,
} = {}) {
  if (outputPath === undefined) throw new TypeError("Topology A output path is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("pilot timeout must be positive");
  if (!Number.isSafeInteger(pingIntervalMs) || pingIntervalMs <= 0)
    throw new TypeError("pilot ping interval must be positive");

  const commandRunner =
    runPilotCommand ??
    ((specification) =>
      executePilotCommand({
        binary: specification.binary,
        args: specification.args,
        input: specification.input,
        cwd: specification.cwd,
        env: specification.env,
        timeoutMs: specification.timeoutMs,
        spawnProcess,
      }));
  const options = {
    runPilotCommand: commandRunner,
    timeoutMs,
    pingIntervalMs,
    sleep,
    now,
    makeSpecification(command, input) {
      return {
        binary: pilotBinary,
        command,
        args: buildPilotArgs({
          socket,
          window,
          command,
          commandArgs: command === "eval" ? ["-"] : [],
        }),
        input,
        cwd: appCwd,
        env: process.env,
        timeoutMs,
      };
    },
  };

  let captured;
  try {
    if (appCommand !== undefined) {
      captured = spawnCapturedApplication(appCommand, {
        cwd: appCwd,
        env: { ...appEnv, AGENT_NANONI_TOPOLOGY_A_BENCH: "1" },
        spawnProcess,
      });
    }
    await waitForPilotPing(options);

    const preOutput = await runPilot(
      options,
      options.makeSpecification("eval", createRendererEvaluationSource()),
    );
    const before = validateTopologyABeforeResult(
      parsePilotJsonOutput(preOutput.stdout, "Topology A pre-reload eval"),
    );

    await runPilot(options, {
      ...options.makeSpecification("eval", "location.reload()"),
      args: buildPilotArgs({ socket, window, command: "eval", commandArgs: ["location.reload()"] }),
      input: undefined,
    });
    await waitForPilotPing(options);

    const postSource = createRendererPostReloadSource(before);
    const postOutput = await runPilot(options, options.makeSpecification("eval", postSource));
    const result = validateTopologyACompleteResult(
      parsePilotJsonOutput(postOutput.stdout, "Topology A post-reload eval"),
    );
    writeTopologyAResult(outputPath, result, { writeFile });
    return result;
  } finally {
    terminateCapturedApplication(captured, { terminate });
  }
}

function parseArguments(argv) {
  const options = { _: [], appArgs: [] };
  let passThrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passThrough) {
      options.appArgs.push(token);
    } else if (token === "--") {
      passThrough = true;
    } else if (token === "--output") {
      options.outputPath = argv[++index];
    } else if (token === "--app") {
      options.app = argv[++index];
    } else if (token === "--pilot") {
      options.pilotBinary = argv[++index];
    } else if (token === "--socket") {
      options.socket = argv[++index];
    } else if (token === "--window") {
      options.window = argv[++index];
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown topology-a-runner option '${token}'`);
    } else {
      options._.push(token);
    }
  }
  if (typeof options.outputPath !== "string" || options.outputPath.length === 0) {
    throw new Error("A result path is required. Pass --output <path>.");
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  return runTopologyAPilot({
    outputPath: parsed.outputPath,
    appCommand: parsed.app === undefined ? undefined : [parsed.app, ...parsed.appArgs],
    pilotBinary: parsed.pilotBinary,
    socket: parsed.socket,
    window: parsed.window,
  });
}

const invoked =
  process.argv[1] && pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const result = await runCli();
    process.stdout.write(`${JSON.stringify({ pass: result.pass, output: true })}\n`);
    if (result.pass !== true) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
