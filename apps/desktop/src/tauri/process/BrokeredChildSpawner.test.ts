import { assert, describe, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { makeBrokeredChildSpawner } from "./BrokeredChildSpawner.ts";
import type { ProcessSpawnParams, RpcProcessBroker } from "./RpcProcessBroker.ts";

type InputWriter = (
  fd: number,
  bytes: Uint8Array,
) => Effect.Effect<void, PlatformError.PlatformError>;

const makeHandle = (
  writeInput: InputWriter = () => Effect.void,
  exitCode = 0,
): ChildProcessSpawner.ChildProcessHandle =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.forEach(() => Effect.void),
    stdout: Stream.make(new TextEncoder().encode("hello\n")),
    stderr: Stream.empty,
    all: Stream.make(new TextEncoder().encode("hello\n")),
    getInputFd: (fd) => Sink.forEach((bytes) => writeInput(fd, bytes)),
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const command = (options: ChildProcess.CommandOptions = {}): ChildProcess.StandardCommand =>
  ChildProcess.make("node", ["script.js"], options);

describe("BrokeredChildSpawner", () => {
  it.effect("maps transport-safe standard options and derived helpers", () =>
    Effect.gen(function* () {
      let received: ProcessSpawnParams | undefined;
      const broker: RpcProcessBroker = {
        spawn: (params: ProcessSpawnParams) => {
          received = params;
          return Effect.succeed({
            _tag: "registered",
            processId: "process-1",
            pid: ChildProcessSpawner.ProcessId(42),
            registrationId: "registration-1",
            handle: makeHandle(),
          } as const);
        },
        close: () => undefined,
        activeProcessCount: () => 1,
      };
      const spawner = makeBrokeredChildSpawner({
        broker,
        kind: "ssh",
        makeAttemptId: () => "attempt-1",
      });

      const text = yield* spawner.string(
        command({
          cwd: "C:\\work",
          env: { KEEP: "yes", DROP: undefined },
          extendEnv: true,
          shell: false,
          stdin: "pipe",
          stdout: "ignore",
          stderr: { stream: "pipe" },
          additionalFds: {
            fd5: { type: "output" },
            fd3: { type: "input" },
          },
        }),
      );
      assert.equal(text, "hello\n");
      assert.deepEqual(received, {
        attemptId: "attempt-1",
        kind: "ssh",
        command: "node",
        args: ["script.js"],
        cwd: "C:\\work",
        env: { KEEP: "yes" },
        extendEnv: true,
        stdin: "pipe",
        stdout: "null",
        stderr: "pipe",
        additionalFds: [
          { fd: 3, direction: "input" },
          { fd: 5, direction: "output" },
        ],
      });
    }),
  );

  it.effect("forwards additional input streams after the broker registers the child", () =>
    Effect.gen(function* () {
      const writes = yield* Queue.unbounded<{ readonly fd: number; readonly bytes: Uint8Array }>();
      let received: ProcessSpawnParams | undefined;
      const broker: RpcProcessBroker = {
        spawn: (params: ProcessSpawnParams) => {
          received = params;
          return Effect.succeed({
            _tag: "registered",
            processId: "process-input",
            pid: ChildProcessSpawner.ProcessId(44),
            registrationId: "registration-input",
            handle: makeHandle((fd, bytes) => Queue.offer(writes, { fd, bytes })),
          } as const);
        },
        close: () => undefined,
        activeProcessCount: () => 1,
      };
      const spawner = makeBrokeredChildSpawner({ broker });
      const bytes = (value: string) => new TextEncoder().encode(value);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* spawner.spawn(
            command({
              additionalFds: {
                fd3: {
                  type: "input",
                  stream: Stream.make(bytes("bootstrap-1"), bytes("bootstrap-2")),
                },
                fd4: {
                  type: "input",
                  stream: Stream.make(bytes("telemetry-1"), bytes("telemetry-2")),
                },
              },
            }),
          );

          const receivedWrites = [
            yield* Queue.take(writes),
            yield* Queue.take(writes),
            yield* Queue.take(writes),
            yield* Queue.take(writes),
          ];
          assert.deepEqual(
            receivedWrites
              .filter(({ fd }) => fd === 3)
              .map(({ bytes: value }) => new TextDecoder().decode(value)),
            ["bootstrap-1", "bootstrap-2"],
          );
          assert.deepEqual(
            receivedWrites
              .filter(({ fd }) => fd === 4)
              .map(({ bytes: value }) => new TextDecoder().decode(value)),
            ["telemetry-1", "telemetry-2"],
          );
        }),
      );

      assert.deepEqual(received?.additionalFds, [
        { fd: 3, direction: "input" },
        { fd: 4, direction: "input" },
      ]);
    }),
  );

  it.effect("releases the registered process when input pumping is interrupted", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const broker: RpcProcessBroker = {
        spawn: () =>
          Effect.acquireRelease(
            Effect.succeed({
              _tag: "registered",
              processId: "process-interrupted-input",
              pid: ChildProcessSpawner.ProcessId(45),
              registrationId: "registration-interrupted-input",
              handle: makeHandle(),
            } as const),
            () => Deferred.succeed(released, undefined),
          ),
        close: () => undefined,
        activeProcessCount: () => 1,
      };
      const spawner = makeBrokeredChildSpawner({ broker });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* spawner.spawn(
            command({
              additionalFds: {
                fd3: { type: "input", stream: Stream.never },
              },
            }),
          );
          yield* Effect.yieldNow;
        }),
      );

      yield* Deferred.await(released);
    }),
  );

  it.effect("rejects piped commands and unsafe native modes", () =>
    Effect.gen(function* () {
      const broker: RpcProcessBroker = {
        spawn: () => Effect.die("spawn should not be called"),
        close: () => undefined,
        activeProcessCount: () => 0,
      };
      const spawner = makeBrokeredChildSpawner({ broker });
      const unsafe = [
        command({ detached: true }),
        command({ shell: true }),
        command({ shell: "/bin/sh" }),
        command({ stdin: "inherit" }),
        command({ stdout: "overlapped" }),
        command({ additionalFds: { fd3: { type: "input", stream: Stream.empty } } }),
      ];
      for (const value of unsafe) {
        const exit = yield* spawner.spawn(value).pipe(Effect.exit);
        assert.isTrue(exit._tag === "Failure");
      }
      const piped = ChildProcess.pipeTo(command(), command());
      const exit = yield* spawner.spawn(piped).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("turns fast exits into terminal handles without a registration", () =>
    Effect.gen(function* () {
      const broker: RpcProcessBroker = {
        spawn: () =>
          Effect.succeed({
            _tag: "fast-exit",
            processId: "fast",
            pid: ChildProcessSpawner.ProcessId(43),
            registrationId: null,
            terminal: Effect.succeed({ type: "process.exit", code: 7 } as const),
            handle: makeHandle(() => Effect.void, 7),
          } as const),
        close: () => undefined,
        activeProcessCount: () => 0,
      };
      const spawner = makeBrokeredChildSpawner({ broker });
      const handle = yield* Effect.scoped(spawner.spawn(command()));
      assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(7));
      assert.equal(
        new TextDecoder().decode(
          Buffer.concat(
            (yield* Stream.runCollect(handle.stdout)).map((chunk) => Buffer.from(chunk)),
          ),
        ),
        "hello\n",
      );
      assert.isFalse(yield* handle.isRunning);
    }),
  );

  it.effect("supports derived lines and exitCode", () =>
    Effect.gen(function* () {
      const broker: RpcProcessBroker = {
        spawn: () =>
          Effect.succeed({
            _tag: "registered",
            processId: "process-1",
            pid: ChildProcessSpawner.ProcessId(42),
            registrationId: "registration-1",
            handle: makeHandle(),
          } as const),
        close: () => undefined,
        activeProcessCount: () => 1,
      };
      const spawner = makeBrokeredChildSpawner({ broker });
      assert.deepEqual(yield* spawner.lines(command()), ["hello"]);
      assert.equal(yield* spawner.exitCode(command()), ChildProcessSpawner.ExitCode(0));
    }),
  );
});
