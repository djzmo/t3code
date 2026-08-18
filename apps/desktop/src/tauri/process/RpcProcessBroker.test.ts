import { assert, describe, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { JsonRpcPeer } from "../rpc/JsonRpcPeer.ts";
import { makeRpcProcessBroker, type ProcessSpawnParams } from "./RpcProcessBroker.ts";

const encoder = new TextEncoder();

const pair = (): { readonly host: JsonRpcPeer; readonly shell: JsonRpcPeer } => {
  let host!: JsonRpcPeer;
  let shell!: JsonRpcPeer;
  host = new JsonRpcPeer({ write: (frame) => shell.receive(frame) });
  shell = new JsonRpcPeer({ write: (frame) => host.receive(frame) });
  return { host, shell };
};

const params = (attemptId: string): ProcessSpawnParams => ({
  attemptId,
  kind: "server",
  command: "node",
  args: ["server.cjs"],
  env: {},
  extendEnv: true,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  additionalFds: [
    { fd: 3, direction: "output" },
    { fd: 4, direction: "input" },
  ],
});

const toBase64 = (value: string): string => Buffer.from(encoder.encode(value)).toString("base64");

const collectText = (chunks: ReadonlyArray<Uint8Array>): string =>
  new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));

const notify = (peer: JsonRpcPeer, method: "process.output" | "process.exit", payload: unknown) =>
  Effect.promise(() => peer.notify(method, payload));

describe("RpcProcessBroker", () => {
  it.effect("demultiplexes two concurrent processes and preserves each order", () =>
    Effect.gen(function* () {
      const { host, shell } = pair();
      shell.onRequest("process.spawn", (raw) => {
        const value = raw as ProcessSpawnParams;
        return {
          processId: `shell-${value.attemptId}`,
          pid: value.attemptId === "one" ? 801 : 802,
          registrationId: `registration-${value.attemptId}`,
        };
      });
      const broker = makeRpcProcessBroker(host);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* broker.spawn(params("one"));
          const second = yield* broker.spawn(params("two"));
          assert.equal(first._tag, "registered");
          assert.equal(second._tag, "registered");
          if (first._tag !== "registered" || second._tag !== "registered") return;

          const firstOutput = yield* Stream.runCollect(first.handle.stdout).pipe(Effect.forkChild);
          const secondOutput = yield* Stream.runCollect(second.handle.stdout).pipe(
            Effect.forkChild,
          );
          yield* notify(shell, "process.output", {
            processId: first.processId,
            fd: 1,
            sequence: 0,
            bytesBase64: toBase64("first-1"),
          });
          yield* notify(shell, "process.output", {
            processId: second.processId,
            fd: 1,
            sequence: 0,
            bytesBase64: toBase64("second-1"),
          });
          yield* notify(shell, "process.output", {
            processId: first.processId,
            fd: 1,
            sequence: 1,
            bytesBase64: toBase64("first-2"),
          });
          yield* notify(shell, "process.exit", {
            processId: second.processId,
            code: 0,
          });
          yield* notify(shell, "process.exit", {
            processId: first.processId,
            code: 0,
          });

          assert.equal(collectText(yield* Fiber.join(firstOutput)), "first-1first-2");
          assert.equal(collectText(yield* Fiber.join(secondOutput)), "second-1");
          assert.equal(yield* first.handle.exitCode, ChildProcessSpawner.ExitCode(0));
          assert.equal(yield* second.handle.exitCode, ChildProcessSpawner.ExitCode(0));
        }),
      );
    }),
  );

  it.effect("encodes input, kill, and release messages on the canonical wire", () =>
    Effect.gen(function* () {
      const { host, shell } = pair();
      const received: unknown[] = [];
      shell.onRequest("process.spawn", () => ({
        processId: "shell-input",
        pid: 803,
        registrationId: "registration-input",
      }));
      shell.onNotification("process.input", (value) => {
        received.push({ method: "input", value });
      });
      shell.onNotification("process.kill", (value) => {
        received.push({ method: "kill", value });
        void shell.notify("process.exit", {
          processId: "shell-input",
          code: 143,
          signal: "SIGTERM",
        });
      });
      shell.onNotification("process.release", (value) => {
        received.push({ method: "release", value });
      });
      const broker = makeRpcProcessBroker(host);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const result = yield* broker.spawn(params("input"));
          assert.equal(result._tag, "registered");
          if (result._tag !== "registered") return;
          yield* Stream.run(Stream.make(encoder.encode("stdin")), result.handle.stdin);
          yield* Stream.run(Stream.make(encoder.encode("fd-input")), result.handle.getInputFd(4));
          yield* result.handle.kill({ killSignal: "SIGTERM" });
          assert.deepEqual(received, [
            {
              method: "input",
              value: {
                processId: "shell-input",
                registrationId: "registration-input",
                fd: 0,
                bytesBase64: toBase64("stdin"),
              },
            },
            {
              method: "input",
              value: {
                processId: "shell-input",
                registrationId: "registration-input",
                fd: 4,
                bytesBase64: toBase64("fd-input"),
              },
            },
            {
              method: "kill",
              value: {
                processId: "shell-input",
                registrationId: "registration-input",
                signal: "SIGTERM",
                forceKillAfterMs: 0,
              },
            },
          ]);
        }),
      );

      assert.deepEqual(received.at(-1), {
        method: "release",
        value: {
          processId: "shell-input",
          registrationId: "registration-input",
        },
      });
    }),
  );

  it.effect("returns a typed fast-exit result when registration is null", () =>
    Effect.gen(function* () {
      const { host, shell } = pair();
      shell.onRequest("process.spawn", () => ({
        processId: "shell-fast",
        pid: 804,
        registrationId: null,
      }));
      const broker = makeRpcProcessBroker(host);

      const result = yield* broker.spawn(params("fast"));
      assert.equal(result._tag, "fast-exit");
      if (result._tag !== "fast-exit") return;
      yield* notify(shell, "process.exit", {
        processId: result.processId,
        code: 17,
      });
      const terminal = yield* result.terminal;
      assert.deepEqual(terminal, {
        type: "process.exit",
        code: 17,
      });
      assert.equal(broker.activeProcessCount(), 0);
    }),
  );

  it.effect("fails active handles exactly once when the peer closes", () =>
    Effect.gen(function* () {
      const { host, shell } = pair();
      shell.onRequest("process.spawn", () => ({
        processId: "shell-close",
        pid: 805,
        registrationId: "registration-close",
      }));
      const broker = makeRpcProcessBroker(host);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const result = yield* broker.spawn(params("close"));
          assert.equal(result._tag, "registered");
          if (result._tag !== "registered") return;
          const first = yield* result.handle.exitCode.pipe(Effect.exit, Effect.forkChild);
          broker.close(new Error("peer EOF"));
          broker.close(new Error("duplicate close"));
          const exit = yield* Fiber.join(first);
          assert.isTrue(Exit.isFailure(exit));
          assert.equal(broker.activeProcessCount(), 0);
        }),
      );
    }),
  );

  it.effect("fails closed when the bounded transport event queue overflows", () =>
    Effect.gen(function* () {
      const { host, shell } = pair();
      shell.onRequest("process.spawn", () => ({
        processId: "shell-overflow",
        pid: 806,
        registrationId: "registration-overflow",
      }));
      const broker = makeRpcProcessBroker(host, { queueCapacity: 1 });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const result = yield* broker.spawn(params("overflow"));
          assert.equal(result._tag, "registered");
          if (result._tag !== "registered") return;
          yield* notify(shell, "process.output", {
            processId: result.processId,
            fd: 1,
            sequence: 0,
            bytesBase64: toBase64("first"),
          });
          yield* notify(shell, "process.output", {
            processId: result.processId,
            fd: 1,
            sequence: 1,
            bytesBase64: toBase64("second"),
          });

          const exit = yield* result.handle.exitCode.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(exit));
        }),
      );
    }),
  );
});
