import * as Cause from "effect/Cause";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

/** A stream owned by a brokered child process. */
export type BrokeredProcessOutput = "stdout" | "stderr" | `fd${number}`;

/**
 * Messages sent by the adapter to a process broker.
 *
 * The port deliberately accepts these typed messages instead of a concrete
 * JSON-RPC client.  A stdio peer, a Tauri command, and an in-memory test port
 * can all implement the same boundary without leaking transport details into
 * the Effect child-process API.
 */
export type BrokeredChildProcessRequest =
  | {
      readonly type: "process.input";
      readonly processId: string;
      readonly registrationId: string;
      readonly fd: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "process.kill";
      readonly processId: string;
      readonly registrationId: string;
      readonly signal: ChildProcess.Signal;
      readonly forceKillAfterMs: number;
    }
  | {
      readonly type: "process.release";
      readonly processId: string;
      readonly registrationId: string;
    };

/**
 * Events delivered by a process broker.
 *
 * `sequence` is one process-wide, zero-based counter.  It is checked before a
 * chunk enters any output queue, so stdout, stderr, and additional fds cannot
 * silently reorder data when the peer is split across multiple callbacks.
 */
export type BrokeredChildProcessEvent =
  | {
      readonly type: "process.output";
      readonly fd: number;
      readonly sequence: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "process.exit";
      readonly code: number | null;
      readonly signal?: string | null;
    }
  | {
      readonly type: "process.closed";
      readonly reason?: string;
    };

/**
 * The transport-neutral side of a process broker.
 *
 * `events` must be a single ordered stream for one process.  Implementations
 * may multiplex it over any transport, but they must preserve event order and
 * report transport failures as a `PlatformError`.
 */
export interface BrokeredChildProcessPort {
  readonly request: (
    request: BrokeredChildProcessRequest,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly events: Stream.Stream<BrokeredChildProcessEvent, PlatformError.PlatformError>;
}

export interface BrokeredChildProcessHandleOptions {
  readonly pid: ChildProcessSpawner.ProcessId | number;
  readonly processId: string;
  readonly registrationId: string;
  readonly port: BrokeredChildProcessPort;
  /** Output descriptors declared by the native spawn request. */
  readonly outputFds?: ReadonlyArray<number>;
  /** Input descriptors declared by the native spawn request. */
  readonly inputFds?: ReadonlyArray<number>;
  /** Per-output bounded queue capacity. Defaults to 128 chunks. */
  readonly queueCapacity?: number;
}

const DEFAULT_QUEUE_CAPACITY = 128;

type QueueError = Cause.Done | PlatformError.PlatformError;
type ByteQueue = Queue.Queue<Uint8Array, QueueError>;

const processError = (
  method: string,
  description: string,
  tag: PlatformError.SystemErrorTag = "InvalidData",
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "brokered-child-process",
    method,
    description,
  });

const normaliseCapacity = (capacity: number | undefined): number =>
  Number.isSafeInteger(capacity) && capacity !== undefined && capacity > 0
    ? capacity
    : DEFAULT_QUEUE_CAPACITY;

const processId = (pid: ChildProcessSpawner.ProcessId | number): ChildProcessSpawner.ProcessId =>
  ChildProcessSpawner.ProcessId(pid);

const signalDescription = (signal: string | null | undefined): string =>
  signal === undefined || signal === null ? "unknown" : signal;

/**
 * Construct an Effect-compatible child process handle backed by a brokered
 * native process.
 *
 * The returned effect is scoped because the event reader and the broker's
 * release message must be tied to the caller's process lifetime.  Queues use a
 * dropping bounded strategy: an output overflow is reported as a platform
 * error rather than allowing an unbounded renderer/host backlog.
 */
export const makeBrokeredChildProcessHandle = (
  options: BrokeredChildProcessHandleOptions,
): Effect.Effect<
  ChildProcessSpawner.ChildProcessHandle,
  PlatformError.PlatformError,
  import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const pid = processId(options.pid);
    const capacity = normaliseCapacity(options.queueCapacity);
    const stdoutQueue = yield* Queue.dropping<Uint8Array, QueueError>(capacity);
    const stderrQueue = yield* Queue.dropping<Uint8Array, QueueError>(capacity);
    const allQueue = yield* Queue.dropping<Uint8Array, QueueError>(capacity);
    const fdQueues = new Map<number, ByteQueue>();
    for (const fd of options.outputFds ?? []) {
      if (Number.isSafeInteger(fd) && fd >= 3) {
        fdQueues.set(fd, yield* Queue.dropping<Uint8Array, QueueError>(capacity));
      }
    }
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>();
    const terminal = {
      settled: false,
      nextSequence: 0,
      released: false,
    };

    const allQueues = (): ReadonlyArray<ByteQueue> => [
      stdoutQueue,
      stderrQueue,
      allQueue,
      ...fdQueues.values(),
    ];

    const endQueues = (): Effect.Effect<void> =>
      Effect.forEach(allQueues(), (queue) => Queue.end(queue), { discard: true });

    const failQueues = (error: PlatformError.PlatformError): Effect.Effect<void> =>
      Effect.forEach(allQueues(), (queue) => Queue.fail(queue, error), { discard: true });

    const settleFailure = (error: PlatformError.PlatformError): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!terminal.settled) {
          terminal.settled = true;
          yield* Deferred.fail(exit, error);
        }
        yield* failQueues(error);
      });

    const settleExit = (
      event: Extract<BrokeredChildProcessEvent, { readonly type: "process.exit" }>,
    ) =>
      Effect.gen(function* () {
        if (terminal.settled) return;
        terminal.settled = true;
        if (event.code !== null && Number.isSafeInteger(event.code) && event.code >= 0) {
          yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(event.code));
          yield* endQueues();
          return;
        }
        const error = processError(
          "exitCode",
          `process interrupted due to receipt of signal: '${signalDescription(event.signal)}'`,
          "Unknown",
        );
        yield* Deferred.fail(exit, error);
        yield* failQueues(error);
      });

    const offer = (queue: ByteQueue, bytes: Uint8Array): Effect.Effect<boolean> =>
      Queue.offer(queue, new Uint8Array(bytes));

    const consume = (
      event: BrokeredChildProcessEvent,
    ): Effect.Effect<void, PlatformError.PlatformError> => {
      if (terminal.settled) return Effect.void;
      switch (event.type) {
        case "process.output": {
          if (
            !Number.isSafeInteger(event.sequence) ||
            event.sequence < 0 ||
            event.sequence !== terminal.nextSequence
          ) {
            const error = processError(
              "output",
              `expected sequence ${String(terminal.nextSequence)}, received ${String(event.sequence)}`,
            );
            return settleFailure(error).pipe(Effect.andThen(Effect.fail(error)));
          }
          terminal.nextSequence += 1;
          const stream: BrokeredProcessOutput =
            event.fd === 1 ? "stdout" : event.fd === 2 ? "stderr" : `fd${event.fd}`;
          const queue =
            stream === "stdout"
              ? stdoutQueue
              : stream === "stderr"
                ? stderrQueue
                : fdQueues.get(event.fd);
          if (queue === undefined) {
            const error = processError(
              "output",
              `output fd '${String(event.fd)}' was not declared`,
            );
            return settleFailure(error).pipe(Effect.andThen(Effect.fail(error)));
          }
          return Effect.gen(function* () {
            const accepted = yield* offer(queue, event.bytes);
            if (!accepted) {
              const error = processError("output", `bounded ${stream} queue is full`, "Busy");
              yield* settleFailure(error);
              return yield* error;
            }
            if (stream === "stdout" || stream === "stderr") {
              const allAccepted = yield* offer(allQueue, event.bytes);
              if (!allAccepted) {
                const error = processError("output", "bounded all queue is full", "Busy");
                yield* settleFailure(error);
                return yield* error;
              }
            }
          });
        }
        case "process.exit":
          return settleExit(event);
        case "process.closed": {
          const error = processError(
            "events",
            event.reason ?? "broker peer closed before process exit",
            "UnexpectedEof",
          );
          return settleFailure(error).pipe(Effect.andThen(Effect.fail(error)));
        }
      }
    };

    const onEventsExit = (
      exitCause: import("effect/Exit").Exit<void, PlatformError.PlatformError>,
    ) =>
      Effect.gen(function* () {
        if (terminal.settled) return;
        const error = (() => {
          if (exitCause._tag === "Failure") {
            const reason = exitCause.cause.reasons[0];
            if (reason !== undefined && Cause.isFailReason(reason)) return reason.error;
          }
          return processError(
            "events",
            "broker event stream ended before process exit",
            "UnexpectedEof",
          );
        })();
        yield* settleFailure(error);
      });

    const eventFiber = yield* options.port.events.pipe(
      Stream.runForEach(consume),
      Effect.onExit(onEventsExit),
      Effect.forkScoped,
    );

    const request = (
      message: BrokeredChildProcessRequest,
    ): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.suspend(() => {
        if (terminal.settled && message.type !== "process.release") {
          return Effect.fail(
            processError("request", "process is no longer available", "UnexpectedEof"),
          );
        }
        return options.port.request(message);
      });

    const stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.forEach(
      (bytes: Uint8Array) =>
        request({
          type: "process.input",
          processId: options.processId,
          registrationId: options.registrationId,
          fd: 0,
          bytes,
        }),
    );

    const getInputFd = (
      fd: number,
    ): Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> => {
      if (!Number.isSafeInteger(fd) || fd < 3 || !options.inputFds?.includes(fd)) {
        return Sink.forEach(
          (_: Uint8Array): Effect.Effect<void, PlatformError.PlatformError> => Effect.void,
        );
      }
      return Sink.forEach((bytes: Uint8Array) =>
        request({
          type: "process.input",
          processId: options.processId,
          registrationId: options.registrationId,
          fd,
          bytes,
        }),
      );
    };

    const getOutputFd = (fd: number): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
      if (!Number.isSafeInteger(fd) || fd < 3) return Stream.empty;
      const queue = fdQueues.get(fd);
      return queue === undefined ? Stream.empty : Stream.fromQueue(queue);
    };

    const kill = (
      killOptions?: ChildProcess.KillOptions,
    ): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const signal = killOptions?.killSignal ?? "SIGTERM";
        yield* request({
          type: "process.kill",
          processId: options.processId,
          registrationId: options.registrationId,
          signal,
          forceKillAfterMs:
            killOptions?.forceKillAfter === undefined
              ? 0
              : Math.max(0, Math.trunc(Duration.toMillis(killOptions.forceKillAfter))),
        });
        yield* Deferred.await(exit).pipe(Effect.asVoid);
      });

    const handle = ChildProcessSpawner.makeHandle({
      pid,
      exitCode: Deferred.await(exit),
      isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
      kill,
      stdin,
      stdout: Stream.fromQueue(stdoutQueue),
      stderr: Stream.fromQueue(stderrQueue),
      all: Stream.fromQueue(allQueue),
      getInputFd,
      getOutputFd,
      // The broker owns process liveness.  There is no local ref-count to
      // alter, so the Effect API's unref operation is intentionally a no-op.
      unref: Effect.succeed(Effect.void),
    });

    yield* Effect.addFinalizer(() =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!terminal.released) {
            terminal.released = true;
            yield* options.port
              .request({
                type: "process.release",
                processId: options.processId,
                registrationId: options.registrationId,
              })
              .pipe(Effect.ignore);
          }
          yield* Fiber.interrupt(eventFiber);
          if (!terminal.settled) {
            yield* settleFailure(
              processError("release", "process handle released", "UnexpectedEof"),
            );
          }
        }),
      ),
    );

    return handle;
  });
