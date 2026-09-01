import { assert, describe, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import {
  decorateManagedChildSpawner,
  type ManagedChildProcessFacts,
  type ManagedChildRegistry,
} from "./ManagedChildSpawner.ts";

const command = ChildProcess.make("fake-command", ["--test"]);
const encoder = new TextEncoder();

const processError = (): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "managed-child-test",
    method: "register",
    description: "registration failed",
  });

const makeHandle = (
  input: {
    readonly pid?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
    readonly kill?: () => Effect.Effect<void, PlatformError.PlatformError>;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
): ChildProcessSpawner.ChildProcessHandle =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid ?? 41),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: input.kill ?? (() => Effect.void),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.make(encoder.encode(`${input.stdout ?? ""}${input.stderr ?? ""}`)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeRegistry = (
  input: {
    readonly register?: (
      facts: ManagedChildProcessFacts,
    ) => Effect.Effect<{ readonly registrationId: string | null }, PlatformError.PlatformError>;
    readonly unregister?: (
      registrationId: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly cancel?: (attemptId: string) => Effect.Effect<void, PlatformError.PlatformError>;
  } = {},
): ManagedChildRegistry => ({
  register: input.register ?? (() => Effect.succeed({ registrationId: "registration-1" })),
  unregister: input.unregister ?? (() => Effect.void),
  cancel: input.cancel ?? (() => Effect.void),
});

const makeDelegate = (
  spawn: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] => ChildProcessSpawner.make(spawn);

describe("ManagedChildSpawner", () => {
  it.effect("registers before exposing the handle", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const handle = makeHandle();
      const delegate = makeDelegate(() =>
        Effect.sync(() => {
          events.push("spawn");
          return handle;
        }),
      );
      const registry = makeRegistry({
        register: (facts) =>
          Effect.sync(() => {
            events.push(`register:${facts.pid}`);
            assert.equal(facts.attemptId, "attempt-1");
            assert.equal(facts.kind, "server");
            assert.equal(facts.spawnedAtMs, 1234);
            return { registrationId: null };
          }),
      });
      const managed = decorateManagedChildSpawner(delegate, {
        registry,
        kind: "server",
        now: () => 1234,
        makeAttemptId: () => "attempt-1",
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const actual = yield* managed.spawn(command);
          events.push("returned");
          assert.strictEqual(actual, handle);
        }),
      );

      assert.deepEqual(events, ["spawn", "register:41", "returned"]);
    }),
  );

  it.effect("forces Unix commands to stay attached while preserving options", () =>
    Effect.gen(function* () {
      let received: ChildProcess.Command | undefined;
      const input = ChildProcess.make("fake-command", ["--test"], {
        cwd: "/worktree",
        detached: true,
        env: { T3_TEST: "1" },
        extendEnv: false,
        shell: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const registry = makeRegistry({ register: () => Effect.succeed({ registrationId: null }) });
      const managed = decorateManagedChildSpawner(
        makeDelegate((spawned) =>
          Effect.sync(() => {
            assert.equal(spawned._tag, "StandardCommand");
            received = spawned;
            return makeHandle();
          }),
        ),
        { registry, platform: "linux" },
      );

      yield* Effect.scoped(managed.spawn(input));

      assert.exists(received);
      assert.equal(received._tag, "StandardCommand");
      assert.deepEqual(received.options, { ...input.options, detached: false });
    }),
  );

  it.effect("serializes only the spawn-to-register transaction", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const firstRegistrationGate = yield* Deferred.make<{
        readonly registrationId: string | null;
      }>();
      const firstRegistrationStarted = yield* Deferred.make<void>();
      const secondRegistrationStarted = yield* Deferred.make<void>();
      let spawnCount = 0;
      let registrationCount = 0;
      const registry = makeRegistry({
        register: () => {
          registrationCount += 1;
          events.push(`register-${String(registrationCount)}`);
          if (registrationCount === 1) {
            return Deferred.succeed(firstRegistrationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(firstRegistrationGate)),
            );
          }
          return Deferred.succeed(secondRegistrationStarted, undefined).pipe(
            Effect.as({ registrationId: null }),
          );
        },
      });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() =>
          Effect.sync(() => {
            spawnCount += 1;
            events.push(`spawn-${String(spawnCount)}`);
            return makeHandle({ pid: 40 + spawnCount });
          }),
        ),
        { registry, makeAttemptId: () => `attempt-${String(spawnCount + 1)}` },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* managed.spawn(command).pipe(Effect.forkChild);
          yield* Deferred.await(firstRegistrationStarted);
          const second = yield* managed.spawn(command).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(secondRegistrationStarted));
          assert.deepEqual(events, ["spawn-1", "register-1"]);

          yield* Deferred.succeed(firstRegistrationGate, { registrationId: null });
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      );

      assert.isTrue(yield* Deferred.isDone(secondRegistrationStarted));
      assert.deepEqual(events, ["spawn-1", "register-1", "spawn-2", "register-2"]);
    }),
  );

  it.effect("unregisters once after the process exits", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const unregistered = yield* Deferred.make<void>();
      const handle = makeHandle({
        exitCode: Deferred.await(exit),
      });
      const registry = makeRegistry({
        register: () => Effect.succeed({ registrationId: "registration-1" }),
        unregister: () =>
          Effect.gen(function* () {
            events.push("unregister");
            yield* Deferred.succeed(unregistered, undefined);
          }),
      });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() => Effect.succeed(handle)),
        { registry, makeAttemptId: () => "attempt-1" },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* managed.spawn(command);
          yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          yield* Deferred.await(unregistered);
        }),
      );

      assert.deepEqual(events, ["unregister"]);
    }),
  );

  it.effect("shares an in-flight unregister with scoped finalization", () =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const unregisterStarted = yield* Deferred.make<void>();
      const unregisterRelease = yield* Deferred.make<void>();
      let unregisterCalls = 0;
      const registry = makeRegistry({
        unregister: () =>
          Effect.gen(function* () {
            unregisterCalls += 1;
            yield* Deferred.succeed(unregisterStarted, undefined);
            yield* Deferred.await(unregisterRelease);
          }),
      });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() =>
          Effect.succeed(
            makeHandle({
              exitCode: Deferred.await(exit),
            }),
          ),
        ),
        { registry },
      );

      const scoped = Effect.scoped(
        Effect.gen(function* () {
          yield* managed.spawn(command);
          yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          yield* Deferred.await(unregisterStarted);
        }),
      );
      const scopeFiber = yield* scoped.pipe(Effect.forkChild);
      yield* Deferred.await(unregisterStarted);
      yield* Effect.yieldNow;

      assert.isUndefined(scopeFiber.pollUnsafe());
      assert.equal(unregisterCalls, 1);

      yield* Deferred.succeed(unregisterRelease, undefined);
      yield* Fiber.join(scopeFiber);
      assert.equal(unregisterCalls, 1);
    }),
  );

  it.effect("kills and cancels when registration fails", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const registry = makeRegistry({
        register: () => Effect.fail(processError()),
        cancel: () => Effect.sync(() => events.push("cancel")),
      });
      const handle = makeHandle({ kill: () => Effect.sync(() => events.push("kill")) });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() => Effect.succeed(handle)),
        {
          registry,
          makeAttemptId: () => "attempt-failed",
        },
      );

      const result = yield* Effect.scoped(Effect.exit(managed.spawn(command)));
      assert.equal(result._tag, "Failure");
      assert.deepEqual(events, ["kill", "cancel"]);
    }),
  );

  it.effect("kills and cancels when registration is interrupted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const registrationStarted = yield* Deferred.make<void>();
      const registrationGate = yield* Deferred.make<{
        readonly registrationId: string | null;
      }>();
      const registry = makeRegistry({
        register: () =>
          Deferred.succeed(registrationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(registrationGate)),
          ),
        cancel: () => Effect.sync(() => events.push("cancel")),
      });
      const handle = makeHandle({ kill: () => Effect.sync(() => events.push("kill")) });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() => Effect.succeed(handle)),
        {
          registry,
          makeAttemptId: () => "attempt-interrupted",
        },
      );

      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* managed.spawn(command).pipe(Effect.forkChild);
          yield* Deferred.await(registrationStarted);
          yield* Fiber.interrupt(fiber);
          return yield* Effect.exit(Fiber.join(fiber));
        }),
      );

      assert.equal(exit._tag, "Failure");
      assert.deepEqual(events, ["kill", "cancel"]);
    }),
  );

  it.effect("unregisters after scoped finalization and does not duplicate exit cleanup", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const handle = makeHandle({
        exitCode: Deferred.await(exit),
        kill: () =>
          Effect.gen(function* () {
            events.push("kill");
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          }),
      });
      const registry = makeRegistry({
        unregister: () => Effect.sync(() => events.push("unregister")),
      });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() => Effect.succeed(handle)),
        {
          registry,
        },
      );

      yield* Effect.scoped(managed.spawn(command).pipe(Effect.asVoid));

      assert.deepEqual(events, ["kill", "unregister"]);
    }),
  );

  it.effect("leaves the registration when exit confirmation fails", () =>
    Effect.gen(function* () {
      let unregisterCount = 0;
      const handle = makeHandle({ exitCode: Effect.fail(processError()) });
      const registry = makeRegistry({
        unregister: () =>
          Effect.sync(() => {
            unregisterCount += 1;
          }),
      });
      const managed = decorateManagedChildSpawner(
        makeDelegate(() => Effect.succeed(handle)),
        {
          registry,
        },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* managed.spawn(command);
          yield* Effect.yieldNow;
        }),
      );

      assert.equal(unregisterCount, 0);
    }),
  );

  it.effect("routes every derived helper through the decorated spawn", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      let registrationCount = 0;
      const delegate = makeDelegate(() =>
        Effect.sync(() => {
          spawnCount += 1;
          return makeHandle({ stdout: "one\ntwo\n" });
        }),
      );
      const registry = makeRegistry({
        register: () =>
          Effect.sync(() => {
            registrationCount += 1;
            return { registrationId: null };
          }),
      });
      const managed = decorateManagedChildSpawner(delegate, { registry });

      yield* Effect.scoped(
        Effect.gen(function* () {
          assert.equal(yield* managed.string(command), "one\ntwo\n");
          assert.deepEqual(yield* managed.lines(command), ["one", "two"]);
          assert.equal(yield* managed.exitCode(command), ChildProcessSpawner.ExitCode(0));
          const lines = yield* managed.streamLines(command).pipe(Stream.runCollect);
          assert.deepEqual(lines, ["one", "two"]);
        }),
      );

      assert.equal(spawnCount, 4);
      assert.equal(registrationCount, 4);
    }),
  );
});
