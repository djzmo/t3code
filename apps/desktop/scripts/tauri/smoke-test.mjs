#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = NodePath.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = NodePath.resolve(scriptDirectory, "../..");

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_READY_PATTERN = /(?:backend[ ._-]+ready|shell\.hello|nanoni\.phase0\.echo)/i;
const SMOKE_HOME_LOG_RELATIVE_PATHS = [
  "userdata/logs/server-child.log",
  "userdata/logs/desktop-main.log",
];
const SMOKE_HOME_DIAGNOSTIC_BYTES = 64 * 1024;

export const hasRequiredSmokeReadiness = (output, readyPattern = DEFAULT_READY_PATTERN) =>
  readyPattern.test(output) && output.includes("AGENT_NANONI_SMOKE first-roundtrip");

export const packagedServerEntryFromBundle = (binaryPath, platform = process.platform) => {
  if (platform !== "darwin") return undefined;
  const macosDirectory = NodePath.dirname(binaryPath);
  if (NodePath.basename(macosDirectory) !== "MacOS") return undefined;
  return NodePath.join(
    macosDirectory,
    "..",
    "Resources",
    "server",
    "apps",
    "server",
    "dist",
    "bin.mjs",
  );
};

export const readSmokeHomeDiagnostics = async (smokeHome, fileSystem = NodeFS) => {
  const sections = [];
  for (const relativePath of SMOKE_HOME_LOG_RELATIVE_PATHS) {
    const path = NodePath.join(smokeHome, relativePath);
    try {
      const text = await fileSystem.readFile(path, "utf8");
      sections.push(`--- ${relativePath} ---\n${text.slice(-SMOKE_HOME_DIAGNOSTIC_BYTES)}`);
    } catch {
      sections.push(`--- ${relativePath} ---\n<missing>`);
    }
  }
  return sections.join("\n");
};

const parseArguments = (argumentsList) => {
  const options = {
    binary: process.env.AGENT_NANONI_TAURI_BIN,
    cwd: process.env.AGENT_NANONI_SMOKE_CWD ?? desktopDirectory,
    timeoutMs: Number(process.env.AGENT_NANONI_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    killHost: process.env.AGENT_NANONI_SMOKE_KILL_HOST === "1",
    readyPattern: DEFAULT_READY_PATTERN,
    childArguments: [],
  };
  let passThrough = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (passThrough) {
      options.childArguments.push(argument);
    } else if (argument === "--") {
      passThrough = true;
    } else if (argument === "--bundle" || argument === "--binary") {
      options.binary = argumentsList[++index];
    } else if (argument === "--cwd") {
      options.cwd = argumentsList[++index];
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(argumentsList[++index]);
    } else if (argument === "--kill-host") {
      options.killHost = true;
    } else if (argument === "--ready") {
      options.readyPattern = new RegExp(argumentsList[++index], "i");
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown smoke-test option '${argument}'.`);
    } else if (!options.binary) {
      options.binary = argument;
    } else {
      options.childArguments.push(argument);
    }
  }
  if (!options.binary) {
    throw new Error(
      "A Tauri executable is required. Pass --bundle <path> or set AGENT_NANONI_TAURI_BIN.",
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Smoke timeout must be a positive integer.");
  }
  options.binary = NodePath.resolve(options.binary);
  options.cwd = NodePath.resolve(options.cwd);
  return options;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const killCapturedProcess = (child, signal) => {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // The PID is captured from this spawn; no name/path matching is involved.
    NodeChildProcess.spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the two checks.
    }
  }
};

export const runSmoke = async (options, dependencies = {}) => {
  const spawn = dependencies.spawn ?? NodeChildProcess.spawn;
  const fileSystem = dependencies.fileSystem ?? NodeFS;
  const configuredSmokeHome = process.env.AGENT_NANONI_SMOKE_HOME;
  const smokeHome =
    configuredSmokeHome ??
    (await fileSystem.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-nanoni-smoke-")));
  try {
    const packagedServerEntry = packagedServerEntryFromBundle(options.binary);
    if (packagedServerEntry !== undefined) {
      try {
        await fileSystem.access(packagedServerEntry);
      } catch {
        throw new Error(
          `Tauri smoke bundle is missing the packaged server entry: ${packagedServerEntry}`,
        );
      }
    }
    const output = [];
    let closed = false;
    let spawnError = null;
    const child = spawn(options.binary, options.childArguments, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      // CREATE_NO_WINDOW can prevent WebView2 from initializing JS on Windows.
      windowsHide: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_NANONI_SMOKE: "1",
        AGENT_NANONI_SMOKE_HOME: smokeHome,
        ...(options.killHost ? { AGENT_NANONI_SMOKE_KILL_HOST: "1" } : {}),
      },
    });

    const append = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      if (output.length > 200) output.shift();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      spawnError = error;
      closed = true;
    });

    let ready = false;
    let exitCode = null;
    let exitSignal = null;
    const closedPromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        closed = true;
        if (exitCode === null) exitCode = code;
        if (exitSignal === null) exitSignal = signal;
        resolve();
      });
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    const snapshotReady = () => hasRequiredSmokeReadiness(output.join(""), options.readyPattern);
    const startedAt = Date.now();
    while (!ready && !closed && Date.now() - startedAt < options.timeoutMs) {
      ready = snapshotReady();
      if (!ready) await sleep(50);
    }
    // `exit` can beat the next poll, and last stdout/stderr `data` can land
    // after `exit`. `close` is the stdio-complete barrier; re-read the buffer
    // after it, and again after any async diagnostics, before throwing.
    if (!ready) {
      if (!closed) await Promise.race([closedPromise, sleep(100)]);
      ready = snapshotReady();
    }

    if (!ready) {
      killCapturedProcess(child, "SIGTERM");
      await Promise.race([closedPromise, sleep(2_000)]);
      const diagnostics = await readSmokeHomeDiagnostics(smokeHome, fileSystem);
      ready = snapshotReady();
      if (!ready) {
        throw new Error(
          spawnError !== null
            ? `Tauri smoke process failed to start: ${spawnError.message}\n${diagnostics}`
            : `Tauri smoke did not reach backend readiness within ${options.timeoutMs}ms.\n${output.join("")}\n${diagnostics}`,
        );
      }
    }

    // The app consumes the smoke environment only after backend readiness. The
    // normal path asks the lifecycle to exit cleanly; the forced path kills only
    // the retained host child and lets the shell prove managed-child cleanup.
    await Promise.race([closedPromise, sleep(10_000)]);
    if (!closed) {
      killCapturedProcess(child, "SIGKILL");
      const diagnostics = await readSmokeHomeDiagnostics(smokeHome, fileSystem);
      throw new Error(
        `Tauri smoke process did not exit after readiness (pid ${child.pid ?? "?"}).\n${output.join("")}\n${diagnostics}`,
      );
    }

    if (!options.killHost && exitCode !== 0) {
      throw new Error(`Tauri smoke exited with code ${exitCode}.\n${output.join("")}`);
    }

    const fullOutput = output.join("");
    if (
      options.killHost &&
      !fullOutput.includes("AGENT_NANONI_SMOKE no-orphans: host-killed cleanup-complete")
    ) {
      throw new Error(
        `Forced-host smoke exited without a successful no-orphans receipt.\n${fullOutput}`,
      );
    }
    process.stdout.write(
      `Tauri smoke passed (${options.killHost ? "forced-kill" : "normal"}); pid=${child.pid ?? "?"}.\n`,
    );
  } finally {
    if (configuredSmokeHome === undefined) {
      await fileSystem.rm(smokeHome, { recursive: true, force: true });
    }
  }
};

if (import.meta.main) {
  try {
    await runSmoke(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
