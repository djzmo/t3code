#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = NodePath.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = NodePath.resolve(scriptDirectory, "../..");

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_READY_PATTERN = /(?:backend[ ._-]+ready|shell\.hello|nanoni\.phase0\.echo)/i;

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
  return options;
};

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

const runSmoke = async (options) => {
  const output = [];
  const child = NodeChildProcess.spawn(options.binary, options.childArguments, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_NANONI_SMOKE: "1",
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

  let ready = false;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  const exitedPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });
  const startedAt = Date.now();
  while (!ready && !exited && Date.now() - startedAt < options.timeoutMs) {
    const snapshot = output.join("");
    ready = options.readyPattern.test(snapshot);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!ready) {
    killCapturedProcess(child, "SIGTERM");
    await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    throw new Error(
      `Tauri smoke did not reach backend readiness within ${options.timeoutMs}ms.\n${output.join("")}`,
    );
  }

  // The forced variant asks the host to exercise its abnormal-shutdown path;
  // the shell remains responsible for draining registered descendants.
  killCapturedProcess(child, options.killHost ? "SIGKILL" : "SIGTERM");
  await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!exited) {
    killCapturedProcess(child, "SIGKILL");
    throw new Error(`Tauri smoke process did not exit after readiness (pid ${child.pid ?? "?"}).`);
  }

  if (!options.killHost && exitCode !== 0 && exitSignal === null) {
    throw new Error(`Tauri smoke exited with code ${exitCode}.\n${output.join("")}`);
  }

  const fullOutput = output.join("");
  if (
    options.killHost &&
    !/no[ ._-]+orphan|children[ ._-]+gone|host[ ._-]+killed/i.test(fullOutput)
  ) {
    process.stderr.write(
      "Warning: forced-kill smoke exited, but no explicit no-orphans receipt was observed.\n",
    );
  }
  process.stdout.write(
    `Tauri smoke passed (${options.killHost ? "forced-kill" : "normal"}); pid=${child.pid ?? "?"}.\n`,
  );
};

try {
  await runSmoke(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
