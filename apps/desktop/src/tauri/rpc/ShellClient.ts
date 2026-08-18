import type { Readable, Writable } from "node:stream";
import { format } from "node:util";

import { JsonRpcPeer, JsonRpcPeerError, type JsonRpcPeerTransport } from "./JsonRpcPeer.ts";
import {
  HELLO_TIMEOUT_MS,
  JSON_RPC_VERSION,
  RpcMethodParams,
  RpcMethodResults,
  type RpcMethodName,
} from "./protocol.ts";

export type RpcParams<M extends RpcMethodName> = (typeof RpcMethodParams)[M]["Type"];
export type RpcResult<M extends RpcMethodName> = (typeof RpcMethodResults)[M]["Type"];

export interface ShellClientByteTransport {
  readonly write: (bytes: Uint8Array) => void | Promise<void>;
  readonly onData: (listener: (bytes: Uint8Array) => void | Promise<void>) => () => void;
  readonly onClose: (listener: (cause?: unknown) => void) => () => void;
  readonly close?: () => void | Promise<void>;
}

export interface ShellHello {
  readonly protocolVersion: string;
  readonly hostPid: number;
}

export interface ShellClientOptions {
  readonly transport: ShellClientByteTransport;
  readonly protocolVersion?: string;
  readonly hostPid?: number;
  readonly helloTimeoutMs?: number;
}

export interface OutputRedirectTarget {
  readonly stdout: {
    write: (...args: never[]) => unknown;
  };
  readonly stderr: {
    write: (...args: never[]) => unknown;
  };
  readonly console?: Pick<Console, "debug" | "info" | "log" | "warn">;
}

/**
 * Redirect incidental host output away from the JSON-RPC stdout stream.
 *
 * The returned function restores the original writers, which keeps this
 * boundary deterministic and easy to exercise in unit tests.
 */
export const redirectOutputToStderr = (target: OutputRedirectTarget): (() => void) => {
  const originalStdoutWrite = target.stdout.write;
  const consoleTarget = target.console ?? console;
  const originalConsole = {
    debug: consoleTarget.debug,
    info: consoleTarget.info,
    log: consoleTarget.log,
    warn: consoleTarget.warn,
  };

  target.stdout.write = (...args: never[]) => {
    target.stderr.write(...args);
  };
  for (const method of Object.keys(originalConsole) as Array<keyof typeof originalConsole>) {
    consoleTarget[method] = ((...args: unknown[]) => {
      target.stderr.write(`${format(...args)}\n` as never);
    }) as Console[typeof method];
  }

  return () => {
    target.stdout.write = originalStdoutWrite;
    consoleTarget.debug = originalConsole.debug;
    consoleTarget.info = originalConsole.info;
    consoleTarget.log = originalConsole.log;
    consoleTarget.warn = originalConsole.warn;
  };
};

export interface NodeStdioTransportOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly console?: Pick<Console, "debug" | "info" | "log" | "warn">;
  readonly redirectOutput?: boolean;
}

/**
 * Adapt Node's stdio streams to the transport-neutral ShellClient boundary.
 */
export const createNodeStdioTransport = (
  options: NodeStdioTransportOptions = {},
): ShellClientByteTransport => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const privateWrite = stdout.write.bind(stdout);
  const removeRedirect =
    options.redirectOutput === false
      ? () => undefined
      : redirectOutputToStderr({
          stdout: stdout as unknown as OutputRedirectTarget["stdout"],
          stderr: stderr as unknown as OutputRedirectTarget["stderr"],
          console: options.console ?? console,
        });
  const dataListeners = new Set<(bytes: Uint8Array) => void | Promise<void>>();
  const closeListeners = new Set<(cause?: unknown) => void>();
  const onData = (chunk: Buffer | string): void => {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    for (const listener of dataListeners) void listener(bytes);
  };
  const onEnd = (): void => {
    for (const listener of closeListeners) listener();
  };
  const onError = (cause: unknown): void => {
    for (const listener of closeListeners) listener(cause);
  };

  stdin.on("data", onData);
  stdin.once("end", onEnd);
  stdin.once("close", onEnd);
  stdin.once("error", onError);

  let closed = false;
  return {
    write: (bytes) => {
      if (closed) throw new JsonRpcPeerError("stdio transport is closed.");
      return new Promise<void>((resolve, reject) => {
        privateWrite(Buffer.from(bytes), (cause?: Error | null) => {
          if (cause) reject(cause);
          else resolve();
        });
      });
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => {
      if (closed) return;
      closed = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdin.removeListener("error", onError);
      dataListeners.clear();
      closeListeners.clear();
      removeRedirect();
    },
  };
};

export class ShellClient {
  readonly #transport: ShellClientByteTransport;
  readonly #peer: JsonRpcPeer;
  readonly #removeDataListener: () => void;
  readonly #removeCloseListener: () => void;
  readonly #helloPromise: Promise<RpcResult<"shell.hello">>;
  #closed = false;

  constructor(options: ShellClientOptions) {
    this.#transport = options.transport;
    const transport: JsonRpcPeerTransport = { write: (frame) => options.transport.write(frame) };
    this.#peer = new JsonRpcPeer(transport);
    this.#removeDataListener = options.transport.onData((bytes) => {
      void this.#receive(bytes);
    });
    this.#removeCloseListener = options.transport.onClose((cause) => {
      this.close(cause);
    });

    const timeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    this.#helloPromise = this.#peer
      .request(
        "shell.hello",
        {
          protocolVersion: options.protocolVersion ?? JSON_RPC_VERSION,
          hostPid: options.hostPid ?? process.pid,
        } satisfies ShellHello,
        signal,
      )
      .catch((cause: unknown) => {
        this.close(cause);
        throw cause;
      }) as Promise<RpcResult<"shell.hello">>;
  }

  get ready(): Promise<RpcResult<"shell.hello">> {
    return this.#helloPromise;
  }

  get pendingCount(): number {
    return this.#peer.pendingCount;
  }

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcParams<M>,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>> {
    await this.ready;
    return (await this.#peer.request(method, params, signal)) as RpcResult<M>;
  }

  async notify<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<void> {
    await this.ready;
    await this.#peer.notify(method, params);
  }

  onEvent<M extends RpcMethodName>(
    method: M,
    handler: (params: RpcParams<M>) => void | Promise<void>,
  ): () => void {
    return this.#peer.onNotification(method, (params) => handler(params as RpcParams<M>));
  }

  onRequest<M extends RpcMethodName>(
    method: M,
    handler: (params: RpcParams<M>, signal: AbortSignal) => RpcResult<M> | Promise<RpcResult<M>>,
  ): () => void {
    return this.#peer.onRequest(method, (params, context) =>
      handler(params as RpcParams<M>, context.signal),
    );
  }

  on<M extends RpcMethodName>(
    method: M,
    handler: (params: RpcParams<M>) => void | Promise<void>,
  ): () => void {
    return this.onEvent(method, handler);
  }

  close(cause?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeDataListener();
    this.#removeCloseListener();
    this.#peer.close(
      cause instanceof JsonRpcPeerError
        ? cause
        : new JsonRpcPeerError(cause instanceof Error ? cause.message : "shell transport closed."),
    );
    void this.#transport.close?.();
  }

  async #receive(bytes: Uint8Array): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#peer.receive(bytes);
    } catch (cause) {
      this.close(cause);
    }
  }
}

export const connectShellClient = async (options: ShellClientOptions): Promise<ShellClient> => {
  const client = new ShellClient(options);
  await client.ready;
  return client;
};
