import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  makeBrokeredChildProcessHandle,
  type BrokeredChildProcessEvent,
  type BrokeredChildProcessPort,
  type BrokeredChildProcessRequest,
} from "./BrokeredChildProcess.ts";

const encoder = new TextEncoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);

const output = (
  stream: "stdout" | "stderr" | `fd${number}`,
  sequence: number,
  value: string,
): BrokeredChildProcessEvent => ({
  type: "process.output",
  fd: stream === "stdout" ? 1 : stream === "stderr" ? 2 : Number(stream.slice(2)),
  sequence,
  bytes: bytes(value),
});

const collect = (value: ReadonlyArray<Uint8Array>): string =>
  new TextDecoder().decode(Buffer.concat(value.map((chunk) => Buffer.from(chunk))));

const makePort = (requests: BrokeredChildProcessRequest[]) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<BrokeredChildProcessEvent, Cause.Done>();
    const port: BrokeredChildProcessPort = {
      events: Stream.fromQueue(events),
      request: (request) => Effect.sync(() => requests.push(request)),
    };
    return { events, port };
  });

describe("BrokeredChildProcess", () => {
  it.effect("preserves stdout/stderr/all ordering and additional output fds", () =>
    Effect.gen(function* () {
      const requests: BrokeredChildProcessRequest[] = [];
      const { events, port } = yield* makePort(requests);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 701,
            processId: "process-701",
            registrationId: "registration-701",
            port,
            outputFds: [3],
          });
          const stdout = yield* Stream.runCollect(handle.stdout).pipe(Effect.forkChild);
          const stderr = yield* Stream.runCollect(handle.stderr).pipe(Effect.forkChild);
          const all = yield* Stream.runCollect(handle.all).pipe(Effect.forkChild);
          const fd3 = yield* Stream.runCollect(handle.getOutputFd(3)).pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          yield* Queue.offer(events, output("stdout", 0, "out-1"));
          yield* Queue.offer(events, output("stderr", 1, "err-1"));
          yield* Queue.offer(events, output("fd3", 2, "fd-1"));
          yield* Queue.offer(events, output("stdout", 3, "out-2"));
          yield* Queue.offer(events, { type: "process.exit", code: 0 });

          assert.equal(collect(yield* Fiber.join(stdout)), "out-1out-2");
          assert.equal(collect(yield* Fiber.join(stderr)), "err-1");
          assert.equal(collect(yield* Fiber.join(all)), "out-1err-1out-2");
          assert.equal(collect(yield* Fiber.join(fd3)), "fd-1");
          assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(0));
          assert.isFalse(yield* handle.isRunning);
        }),
      );

      assert.deepEqual(requests, [
        {
          type: "process.release",
          processId: "process-701",
          registrationId: "registration-701",
        },
      ]);
    }),
  );

  it.effect("writes stdin and mapped fd input, carries the kill token, and releases", () =>
    Effect.gen(function* () {
      const requests: BrokeredChildProcessRequest[] = [];
      const { events, port } = yield* makePort(requests);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 702,
            processId: "process-702",
            registrationId: "registration-702",
            port,
            inputFds: [4],
          });

          yield* Stream.run(Stream.make(bytes("stdin")), handle.stdin);
          yield* Stream.run(Stream.make(bytes("fd-input")), handle.getInputFd(4));
          const reref = yield* handle.unref;
          yield* reref;

          const kill = yield* handle.kill({ killSignal: "SIGINT" }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.deepEqual(requests, [
            {
              type: "process.input",
              processId: "process-702",
              registrationId: "registration-702",
              fd: 0,
              bytes: bytes("stdin"),
            },
            {
              type: "process.input",
              processId: "process-702",
              registrationId: "registration-702",
              fd: 4,
              bytes: bytes("fd-input"),
            },
            {
              type: "process.kill",
              processId: "process-702",
              registrationId: "registration-702",
              signal: "SIGINT",
              forceKillAfterMs: 0,
            },
          ]);
          yield* Queue.offer(events, { type: "process.exit", code: 130, signal: "SIGINT" });
          yield* Fiber.join(kill);
        }),
      );

      assert.deepEqual(requests.at(-1), {
        type: "process.release",
        processId: "process-702",
        registrationId: "registration-702",
      });
    }),
  );

  it.effect("preserves fast-exit output and reports peer closure", () =>
    Effect.gen(function* () {
      const requests: BrokeredChildProcessRequest[] = [];
      const first = yield* makePort(requests);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 703,
            processId: "process-703",
            registrationId: "registration-703",
            port: first.port,
          });
          yield* Queue.offer(first.events, output("stdout", 0, "fast"));
          yield* Queue.offer(first.events, { type: "process.exit", code: 7 });
          assert.equal(collect(yield* Stream.runCollect(handle.stdout)), "fast");
          assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(7));
        }),
      );

      const second = yield* makePort([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 704,
            processId: "process-704",
            registrationId: "registration-704",
            port: second.port,
          });
          const stream = yield* Stream.runCollect(handle.stderr).pipe(
            Effect.exit,
            Effect.forkChild,
          );
          const exitCode = yield* handle.exitCode.pipe(Effect.exit, Effect.forkChild);
          yield* Queue.offer(second.events, { type: "process.closed", reason: "peer EOF" });
          const streamExit = yield* Fiber.join(stream);
          const codeExit = yield* Fiber.join(exitCode);
          assert.isTrue(Exit.isFailure(streamExit));
          assert.isTrue(Exit.isFailure(codeExit));
        }),
      );
    }),
  );

  it.effect("keeps fast-exit output read-only without broker requests", () =>
    Effect.gen(function* () {
      const requests: BrokeredChildProcessRequest[] = [];
      const { events, port } = yield* makePort(requests);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 707,
            processId: "process-707",
            registrationId: null,
            port,
            outputFds: [3],
            inputFds: [4],
          });
          const stdout = yield* Stream.runCollect(handle.stdout).pipe(Effect.forkChild);
          const stderr = yield* Stream.runCollect(handle.stderr).pipe(Effect.forkChild);
          const all = yield* Stream.runCollect(handle.all).pipe(Effect.forkChild);
          const fd3 = yield* Stream.runCollect(handle.getOutputFd(3)).pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          const stdinExit = yield* Stream.run(Stream.make(bytes("input")), handle.stdin).pipe(
            Effect.exit,
          );
          const fdInputExit = yield* Stream.run(
            Stream.make(bytes("fd-input")),
            handle.getInputFd(4),
          ).pipe(Effect.exit);
          const killExit = yield* handle.kill().pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(stdinExit));
          assert.isTrue(Exit.isFailure(fdInputExit));
          assert.isTrue(Exit.isFailure(killExit));
          assert.deepEqual(requests, []);

          yield* Queue.offer(events, output("stdout", 0, "out"));
          yield* Queue.offer(events, output("stderr", 1, "err"));
          yield* Queue.offer(events, output("fd3", 2, "fd"));
          yield* Queue.offer(events, { type: "process.exit", code: 0 });

          assert.equal(collect(yield* Fiber.join(stdout)), "out");
          assert.equal(collect(yield* Fiber.join(stderr)), "err");
          assert.equal(collect(yield* Fiber.join(all)), "outerr");
          assert.equal(collect(yield* Fiber.join(fd3)), "fd");
          assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(0));
        }),
      );

      assert.deepEqual(requests, []);
    }),
  );

  it.effect("rejects out-of-order output and bounded queue overflow", () =>
    Effect.gen(function* () {
      const requests: BrokeredChildProcessRequest[] = [];
      const first = yield* makePort(requests);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 705,
            processId: "process-705",
            registrationId: "registration-705",
            port: first.port,
            queueCapacity: 2,
          });
          const result = yield* handle.exitCode.pipe(Effect.exit, Effect.forkChild);
          yield* Queue.offer(first.events, output("stdout", 1, "wrong"));
          const exit = yield* Fiber.join(result);
          assert.isTrue(Exit.isFailure(exit));
        }),
      );

      const second = yield* makePort([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeBrokeredChildProcessHandle({
            pid: 706,
            processId: "process-706",
            registrationId: "registration-706",
            port: second.port,
            queueCapacity: 1,
          });
          const result = yield* handle.exitCode.pipe(Effect.exit, Effect.forkChild);
          yield* Queue.offer(second.events, output("stdout", 0, "one"));
          yield* Queue.offer(second.events, output("stdout", 1, "two"));
          const exit = yield* Fiber.join(result);
          assert.isTrue(Exit.isFailure(exit));
        }),
      );
    }),
  );
});
