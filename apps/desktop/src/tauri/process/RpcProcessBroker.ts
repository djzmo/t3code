import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { JsonRpcPeer, JsonRpcPeerError } from "../rpc/JsonRpcPeer.ts";
import { RpcMethodParams, RpcMethodResults } from "../rpc/protocol.ts";
import {
  makeBrokeredChildProcessHandle,
  type BrokeredChildProcessEvent,
  type BrokeredChildProcessPort,
  type BrokeredChildProcessRequest,
} from "./BrokeredChildProcess.ts";

type ProcessSpawnParams = (typeof RpcMethodParams)["process.spawn"]["Type"];
type ProcessSpawnResult = (typeof RpcMethodResults)["process.spawn"]["Type"];
type ProcessOutputParams = (typeof RpcMethodParams)["process.output"]["Type"];
type ProcessExitParams = (typeof RpcMethodParams)["process.exit"]["Type"];

type ProcessExitEvent = Extract<BrokeredChildProcessEvent, { readonly type: "process.exit" }>;

const decodeSpawnParams = Schema.decodeUnknownSync(RpcMethodParams["process.spawn"]);
const decodeSpawnResult = Schema.decodeUnknownSync(RpcMethodResults["process.spawn"]);
const decodeOutputParams = Schema.decodeUnknownSync(RpcMethodParams["process.output"]);
const decodeExitParams = Schema.decodeUnknownSync(RpcMethodParams["process.exit"]);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A typed failure from the RPC process broker boundary. */
export class RpcProcessBrokerError extends Error {
  readonly _tag = "RpcProcessBrokerError" as const;
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, message: string, cause?: unknown) {
    super(message);
    this.name = "RpcProcessBrokerError";
    this.operation = operation;
    this.cause = cause;
  }
}

/** A process returned with no registration token because it exited during spawn. */
export interface RpcFastExitProcess {
  readonly _tag: "fast-exit";
  readonly processId: string;
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly registrationId: null;
  /** The native terminal event, including a nullable exit code and signal. */
  readonly terminal: Effect.Effect<ProcessExitEvent, PlatformError.PlatformError>;
}

/** A process with a retained native registration and a live Effect handle. */
export interface RpcRegisteredProcess {
  readonly _tag: "registered";
  readonly processId: string;
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly registrationId: string;
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
}

export type RpcProcessSpawned = RpcRegisteredProcess | RpcFastExitProcess;

export interface RpcProcessBrokerOptions {
  /** Bounded output queues are owned by makeBrokeredChildProcessHandle. */
  readonly queueCapacity?: number;
}

export interface RpcProcessBroker {
  /** Spawn through the shell and adapt the returned process into an Effect handle. */
  readonly spawn: (
    params: ProcessSpawnParams,
  ) => Effect.Effect<
    RpcProcessSpawned,
    RpcProcessBrokerError | PlatformError.PlatformError,
    import("effect/Scope").Scope
  >;
  /**
   * Notify the adapter that the underlying peer has closed.
   *
   * JsonRpcPeer intentionally stays transport-agnostic and exposes no close
   * subscription.  The owner that observes peer.close() calls this method;
   * every active process port is then failed exactly once.
   */
  readonly close: (cause?: unknown) => void;
  readonly activeProcessCount: () => number;
}

interface ProcessPortState {
  readonly processId: string;
  readonly queue: Queue.Queue<BrokeredChildProcessEvent, PlatformError.PlatformError>;
  readonly terminal: Deferred.Deferred<ProcessExitEvent, PlatformError.PlatformError>;
  readonly retainOutput: boolean;
  closed: boolean;
}

const platformError = (
  method: string,
  description: string,
  tag: PlatformError.SystemErrorTag = "Unknown",
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "rpc-process-broker",
    method,
    description,
  });

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const decodeBase64 = (value: string, operation: string): Uint8Array => {
  if (!BASE64.test(value)) {
    throw new RpcProcessBrokerError(operation, "process event contains invalid base64 bytes");
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
};

const processIdFrom = (value: string): string => value;

const asProcessId = (value: number): ChildProcessSpawner.ProcessId =>
  ChildProcessSpawner.ProcessId(value);

const processExitEvent = (params: ProcessExitParams): ProcessExitEvent => ({
  type: "process.exit",
  code: params.code,
  ...(params.signal === undefined ? {} : { signal: params.signal }),
});

const outputEvent = (params: ProcessOutputParams): BrokeredChildProcessEvent => ({
  type: "process.output",
  fd: params.fd,
  sequence: params.sequence,
  bytes: decodeBase64(params.bytesBase64, "process.output"),
});

const spawnFailure = (operation: string, cause: unknown): RpcProcessBrokerError =>
  new RpcProcessBrokerError(
    operation,
    `process broker ${operation} failed: ${describeCause(cause)}`,
    cause,
  );

/**
 * Build a process-broker adapter over one JsonRpcPeer.
 *
 * The shell mints process IDs in the spawn response.  Output and exit
 * notifications are accepted only for IDs currently registered by that
 * response; host attempt IDs never route native events.
 */
export const makeRpcProcessBroker = (
  peer: JsonRpcPeer,
  options: RpcProcessBrokerOptions = {},
): RpcProcessBroker => {
  const ports = new Map<string, ProcessPortState>();
  const queueCapacity =
    Number.isSafeInteger(options.queueCapacity) && options.queueCapacity !== undefined
      ? Math.max(1, options.queueCapacity)
      : 128;
  let closedCause: unknown;
  let disposeOutput = (): void => undefined;
  let disposeExit = (): void => undefined;

  const runSync = <A>(effect: Effect.Effect<A, never>): void => {
    try {
      Effect.runSync(effect);
    } catch {
      // Queue/Deferred failures are terminal state transitions. A second
      // transition is intentionally ignored by the close path.
    }
  };

  const failPort = (state: ProcessPortState, cause: PlatformError.PlatformError): void => {
    if (state.closed) return;
    state.closed = true;
    runSync(Queue.fail(state.queue, cause));
    runSync(Deferred.fail(state.terminal, cause));
  };

  const removePort = (state: ProcessPortState): void => {
    if (ports.get(state.processId) === state) ports.delete(state.processId);
    state.closed = true;
  };

  const offer = (state: ProcessPortState, event: BrokeredChildProcessEvent): void => {
    if (state.closed) return;
    if (event.type === "process.output" && !state.retainOutput) return;
    const accepted = Effect.runSync(Queue.offer(state.queue, event));
    if (!accepted) {
      failPort(state, platformError("events", "bounded process event queue is full", "Busy"));
      return;
    }
    if (event.type === "process.exit") {
      runSync(Deferred.succeed(state.terminal, event));
    }
  };

  const onOutput = (raw: unknown): void => {
    try {
      const params = decodeOutputParams(raw);
      const state = ports.get(processIdFrom(params.processId));
      if (state === undefined) return;
      offer(state, outputEvent(params));
    } catch (cause) {
      close(cause);
    }
  };

  const onExit = (raw: unknown): void => {
    try {
      const params = decodeExitParams(raw);
      const state = ports.get(processIdFrom(params.processId));
      if (state === undefined) return;
      offer(state, processExitEvent(params));
    } catch (cause) {
      close(cause);
    }
  };

  const close = (cause: unknown = new JsonRpcPeerError("JSON-RPC process peer closed.")): void => {
    if (closedCause !== undefined) return;
    closedCause = cause;
    disposeOutput();
    disposeExit();
    const error = platformError(
      "close",
      `process broker peer closed: ${describeCause(cause)}`,
      "UnexpectedEof",
    );
    for (const state of ports.values()) failPort(state, error);
    ports.clear();
  };

  disposeOutput = peer.onNotification("process.output", onOutput);
  disposeExit = peer.onNotification("process.exit", onExit);

  const request = <T>(
    method: "process.spawn",
    params: ProcessSpawnParams,
  ): Effect.Effect<T, RpcProcessBrokerError> =>
    Effect.tryPromise({
      try: async () => (await peer.request(method, params)) as T,
      catch: (cause) => spawnFailure(method, cause),
    });

  const makePort = (state: ProcessPortState, registrationId: string): BrokeredChildProcessPort => ({
    events: Stream.fromQueue(state.queue),
    request: (message: BrokeredChildProcessRequest) => {
      if (closedCause !== undefined || state.closed) {
        return Effect.fail(
          platformError("request", "process broker peer is closed", "UnexpectedEof"),
        );
      }
      const send = (() => {
        switch (message.type) {
          case "process.input":
            return peer.notify("process.input", {
              processId: message.processId,
              registrationId,
              fd: message.fd,
              bytesBase64: encodeBase64(message.bytes),
            });
          case "process.kill":
            return peer.notify("process.kill", {
              processId: message.processId,
              registrationId,
              signal: message.signal,
              forceKillAfterMs: message.forceKillAfterMs,
            });
          case "process.release":
            return peer.notify("process.release", {
              processId: message.processId,
              registrationId,
            });
        }
      })();
      const effect = Effect.tryPromise({
        try: async () => {
          await send;
        },
        catch: (cause) => platformError(message.type, describeCause(cause), "UnexpectedEof"),
      });
      return message.type === "process.release"
        ? effect.pipe(Effect.ensuring(Effect.sync(() => removePort(state))))
        : effect;
    },
  });

  const spawn = (
    rawParams: ProcessSpawnParams,
  ): Effect.Effect<
    RpcProcessSpawned,
    RpcProcessBrokerError | PlatformError.PlatformError,
    import("effect/Scope").Scope
  > =>
    Effect.gen(function* () {
      if (closedCause !== undefined) {
        return yield* Effect.fail(
          platformError("spawn", "process broker peer is closed", "UnexpectedEof"),
        );
      }
      let params: ProcessSpawnParams;
      try {
        params = decodeSpawnParams(rawParams);
      } catch (cause) {
        return yield* Effect.fail(spawnFailure("process.spawn.params", cause));
      }
      let decoded: ProcessSpawnResult;
      try {
        decoded = yield* request<ProcessSpawnResult>("process.spawn", params);
        decoded = decodeSpawnResult(decoded);
      } catch (cause) {
        return yield* Effect.fail(
          cause instanceof RpcProcessBrokerError
            ? cause
            : spawnFailure("process.spawn.result", cause),
        );
      }
      const processId = processIdFrom(decoded.processId);
      if (ports.has(processId)) {
        return yield* Effect.fail(
          spawnFailure("process.spawn.result", `duplicate shell processId '${processId}'`),
        );
      }
      const queue = yield* Queue.dropping<BrokeredChildProcessEvent, PlatformError.PlatformError>(
        queueCapacity,
      );
      const terminal = yield* Deferred.make<ProcessExitEvent, PlatformError.PlatformError>();
      const state: ProcessPortState = {
        processId,
        queue,
        terminal,
        retainOutput: decoded.registrationId !== null,
        closed: false,
      };
      ports.set(processId, state);
      if (decoded.registrationId === null) {
        const terminalEffect = Deferred.await(terminal).pipe(
          Effect.ensuring(Effect.sync(() => removePort(state))),
        );
        return {
          _tag: "fast-exit",
          processId,
          pid: asProcessId(decoded.pid),
          registrationId: null,
          terminal: terminalEffect,
        } satisfies RpcFastExitProcess;
      }
      const outputFds = params.additionalFds
        .filter((fd) => fd.direction === "output")
        .map((fd) => fd.fd);
      const inputFds = params.additionalFds
        .filter((fd) => fd.direction === "input")
        .map((fd) => fd.fd);
      const handle = yield* makeBrokeredChildProcessHandle({
        pid: asProcessId(decoded.pid),
        processId,
        registrationId: decoded.registrationId,
        port: makePort(state, decoded.registrationId),
        outputFds,
        inputFds,
        queueCapacity,
      });
      return {
        _tag: "registered",
        processId,
        pid: asProcessId(decoded.pid),
        registrationId: decoded.registrationId,
        handle,
      } satisfies RpcRegisteredProcess;
    });

  return {
    spawn,
    close,
    activeProcessCount: () => ports.size,
  };
};

export type { ProcessExitParams, ProcessOutputParams, ProcessSpawnParams, ProcessSpawnResult };
