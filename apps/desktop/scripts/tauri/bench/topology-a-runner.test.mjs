import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { assert, describe, it } from "vite-plus/test";

import {
  buildPilotArgs,
  executePilotCommand,
  parsePilotJsonOutput,
  runTopologyAPilot,
  serializeTopologyAResult,
  validateTopologyABeforeResult,
  validateTopologyACompleteResult,
} from "./topology-a-runner.mjs";

const beforeResult = {
  schemaVersion: 1,
  channel: "desktop:phase0-topology-a-bench",
  phase: "before-reload",
  criteria: { echoCount: true, reloadStable: false },
  reload: {
    before: { boot: { version: "1" }, sync: { locale: "en-US" } },
    after: null,
    bootEqual: false,
    syncEqual: false,
    stable: false,
  },
};

const completeResult = {
  ...beforeResult,
  phase: "complete",
  criteria: { echoCount: true, reloadStable: true },
  reload: {
    before: beforeResult.reload.before,
    after: { boot: { version: "1" }, sync: { locale: "en-US" } },
    bootEqual: true,
    syncEqual: true,
    stable: true,
  },
  pass: true,
};

describe("Topology A tauri-pilot runner", () => {
  it("builds shell-free pilot arguments with global flags before the command", () => {
    assert.deepEqual(
      buildPilotArgs({
        socket: "/tmp/pilot.sock",
        window: "main",
        command: "eval",
        commandArgs: ["-"],
      }),
      ["--socket", "/tmp/pilot.sock", "--window", "main", "--json", "eval", "-"],
    );
  });

  it("accepts one complete JSON value and rejects noise or error envelopes", () => {
    assert.deepEqual(parsePilotJsonOutput('{"status":"ok"}'), { status: "ok" });
    assert.throws(() => parsePilotJsonOutput('ok\n{"status":"ok"}'), /non-JSON/);
    assert.throws(
      () => parsePilotJsonOutput('{"error":{"message":"socket unavailable"}}'),
      /socket unavailable/,
    );
    assert.throws(() => parsePilotJsonOutput(""), /no JSON/);
  });

  it("terminates a captured pilot command that exceeds its deadline", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    let killed = false;
    child.kill = () => {
      killed = true;
      return true;
    };

    let error;
    try {
      await executePilotCommand({
        args: ["--json", "ping"],
        timeoutMs: 1,
        spawnProcess: () => child,
      });
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /timed out after 1 ms/);
    assert.isTrue(killed);
  });

  it("pings, evaluates, reloads, evaluates with the exact pre-result, writes JSON, and cleans one captured child", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-topology-a-runner-"));
    const outputPath = path.join(fixture, "result.json");
    const calls = [];
    const terminated = [];
    let pingCount = 0;
    let capturedSpawn;
    try {
      const result = await runTopologyAPilot({
        outputPath,
        appCommand: ["fake-tauri.exe", "--safe-arg"],
        spawnProcess(command, args, options) {
          capturedSpawn = { command, args, options };
          return { pid: 4242 };
        },
        terminate(captured) {
          terminated.push(captured);
        },
        runPilotCommand(specification) {
          calls.push(specification);
          if (specification.command === "ping") {
            pingCount += 1;
            return { exitCode: 0, stdout: JSON.stringify({ status: "ok" }), stderr: "" };
          }
          if (
            specification.command === "eval" &&
            specification.args.at(-1) === "location.reload()"
          ) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (
            specification.command === "eval" &&
            calls.filter(({ command }) => command === "eval").length === 1
          ) {
            return { exitCode: 0, stdout: JSON.stringify(beforeResult), stderr: "" };
          }
          if (specification.command === "eval") {
            assert.include(specification.input, JSON.stringify(beforeResult));
            return { exitCode: 0, stdout: JSON.stringify(completeResult), stderr: "" };
          }
          throw new Error(`unexpected command ${specification.command}`);
        },
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        sleep: async () => undefined,
      });

      assert.deepEqual(result, completeResult);
      assert.equal(pingCount, 2);
      assert.equal(calls.filter(({ command }) => command === "eval").length, 3);
      assert.equal(capturedSpawn.command, "fake-tauri.exe");
      assert.deepEqual(capturedSpawn.args, ["--safe-arg"]);
      assert.isFalse(capturedSpawn.options.shell);
      assert.equal(capturedSpawn.options.env.AGENT_NANONI_TOPOLOGY_A_BENCH, "1");
      assert.deepEqual(
        terminated.map(({ pid, groupId }) => ({ pid, groupId })),
        [{ pid: 4242, groupId: process.platform === "win32" ? null : 4242 }],
      );
      assert.equal(fs.readFileSync(outputPath, "utf8"), serializeTopologyAResult(completeResult));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("fails closed on a wrong phase and still cleans the captured child", async () => {
    const terminated = [];
    let error;
    try {
      await runTopologyAPilot({
        outputPath: path.join(os.tmpdir(), "topology-a-invalid.json"),
        appCommand: ["fake-tauri"],
        spawnProcess: () => ({ pid: 7070 }),
        terminate: (captured) => terminated.push(captured.pid),
        runPilotCommand: ({ command }) =>
          command === "ping"
            ? { exitCode: 0, stdout: '{"status":"ok"}' }
            : { exitCode: 0, stdout: JSON.stringify(completeResult) },
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        sleep: async () => undefined,
      });
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /pre-reload result.*schema or phase/);
    assert.deepEqual(terminated, [7070]);
    assert.throws(() => validateTopologyABeforeResult(completeResult), /schema or phase/);
    assert.throws(() => validateTopologyACompleteResult(beforeResult), /schema or phase/);
  });
});
