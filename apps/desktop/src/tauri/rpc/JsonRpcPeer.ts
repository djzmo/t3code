import {
  MAX_FRAME_BYTES,
  MAX_NESTING_DEPTH,
  MAX_PENDING_REQUESTS,
  RPC_ERROR_CODES,
  decodeEnvelope,
  decodeMethodResult,
  type RpcMethodName as RpcMethod,
} from "./protocol.ts";

const RECORD_SEPARATOR = 0x1e;
const NEWLINE = 0x0a;
const COLON = 0x3a;
const MAX_PREFIX_BYTES = 32;

type JsonRpcId = number;
type JsonRpcValue = Readonly<Record<string, unknown>>;

export class JsonRpcPeerError extends Error {
  readonly code: number | undefined;
  readonly kind: string | undefined;

  constructor(message: string, options?: { readonly code?: number; readonly kind?: string }) {
    super(message);
    this.name = "JsonRpcPeerError";
    this.code = options?.code;
    this.kind = options?.kind;
  }
}

export interface JsonRpcPeerTransport {
  readonly write: (frame: Uint8Array) => void | Promise<void>;
}

export interface JsonRpcRequestContext {
  readonly id: number;
  readonly signal: AbortSignal;
}

export type JsonRpcRequestHandler = (
  params: unknown,
  context: JsonRpcRequestContext,
) => unknown | Promise<unknown>;
export type JsonRpcNotificationHandler = (params: unknown) => void | Promise<void>;

interface PendingRequest {
  readonly method: RpcMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const concat = (
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> => {
  const value = new Uint8Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return value;
};

const nestingDepth = (value: unknown, depth = 0): number => {
  if (value === null || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  let maximum = depth;
  for (const child of children) maximum = Math.max(maximum, nestingDepth(child, depth + 1));
  return maximum;
};

export const encodeJsonRpcFrame = (value: unknown): Uint8Array => {
  const json = encoder.encode(JSON.stringify(value));
  if (json.length > MAX_FRAME_BYTES) {
    throw new JsonRpcPeerError(`JSON-RPC frame exceeds ${MAX_FRAME_BYTES} bytes.`);
  }
  const prefix = encoder.encode(`\u001e${json.length}:`);
  return concat(concat(prefix, json), Uint8Array.of(NEWLINE));
};

class FrameDecoder {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  push(chunk: Uint8Array<ArrayBufferLike>): unknown[] {
    this.#buffer = concat(this.#buffer, chunk);
    const values: unknown[] = [];
    while (this.#buffer.length > 0) {
      const separator = this.#buffer.indexOf(RECORD_SEPARATOR);
      if (separator < 0) {
        this.#buffer = new Uint8Array();
        break;
      }
      if (separator > 0) this.#buffer = this.#buffer.slice(separator);
      const colon = this.#buffer.indexOf(COLON, 1);
      if (colon < 0) {
        if (this.#buffer.length > MAX_PREFIX_BYTES) this.#buffer = this.#buffer.slice(1);
        break;
      }
      const lengthText = decoder.decode(this.#buffer.slice(1, colon));
      if (!/^(0|[1-9]\d*)$/.test(lengthText)) {
        this.#buffer = this.#buffer.slice(1);
        continue;
      }
      const length = Number(lengthText);
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
        throw new JsonRpcPeerError(`Invalid JSON-RPC frame length ${lengthText}.`);
      }
      const jsonStart = colon + 1;
      const frameEnd = jsonStart + length;
      if (this.#buffer.length <= frameEnd) break;
      if (this.#buffer[frameEnd] !== NEWLINE) {
        this.#buffer = this.#buffer.slice(1);
        continue;
      }
      const json = decoder.decode(this.#buffer.slice(jsonStart, frameEnd));
      const value: unknown = JSON.parse(json);
      if (nestingDepth(value) > MAX_NESTING_DEPTH) {
        throw new JsonRpcPeerError(`JSON-RPC value exceeds nesting depth ${MAX_NESTING_DEPTH}.`);
      }
      values.push(value);
      this.#buffer = this.#buffer.slice(frameEnd + 1);
    }
    return values;
  }
}

export class JsonRpcPeer {
  readonly #transport: JsonRpcPeerTransport;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #activeRequests = new Map<JsonRpcId, AbortController>();
  readonly #requests = new Map<RpcMethod, JsonRpcRequestHandler>();
  readonly #notifications = new Map<RpcMethod, Set<JsonRpcNotificationHandler>>();
  #nextId = 1;
  #closed: JsonRpcPeerError | undefined;

  constructor(transport: JsonRpcPeerTransport) {
    this.#transport = transport;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  onRequest(method: RpcMethod, handler: JsonRpcRequestHandler): () => void {
    this.#requests.set(method, handler);
    return () => {
      if (this.#requests.get(method) === handler) this.#requests.delete(method);
    };
  }

  onNotification(method: RpcMethod, handler: JsonRpcNotificationHandler): () => void {
    const handlers = this.#notifications.get(method) ?? new Set<JsonRpcNotificationHandler>();
    handlers.add(handler);
    this.#notifications.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#notifications.delete(method);
    };
  }

  async request(method: RpcMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#assertOpen();
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new JsonRpcPeerError("JSON-RPC pending request limit reached.", {
        code: RPC_ERROR_CODES.platform,
      });
    }
    const id = this.#allocateId();
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
    });
    const abort = () => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      pending.reject(new JsonRpcPeerError(`JSON-RPC request ${id} was cancelled.`));
      void this.#write({ jsonrpc: "2.0", method: "$/cancel", params: { id } });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.#write({ jsonrpc: "2.0", id, method, params });
      return await result;
    } catch (cause) {
      this.#pending.delete(id);
      throw cause;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  notify(method: RpcMethod, params: unknown): Promise<void> {
    this.#assertOpen();
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  async receive(chunk: Uint8Array<ArrayBufferLike>): Promise<void> {
    this.#assertOpen();
    for (const value of this.#decoder.push(chunk)) await this.#dispatch(value);
  }

  close(cause = new JsonRpcPeerError("JSON-RPC transport closed.")): void {
    if (this.#closed !== undefined) return;
    this.#closed = cause;
    for (const pending of this.#pending.values()) pending.reject(cause);
    this.#pending.clear();
    for (const controller of this.#activeRequests.values()) controller.abort(cause);
    this.#activeRequests.clear();
  }

  #assertOpen(): void {
    if (this.#closed !== undefined) throw this.#closed;
  }

  #allocateId(): number {
    for (let attempts = 0; attempts <= MAX_PENDING_REQUESTS; attempts += 1) {
      const id = this.#nextId;
      this.#nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
      if (!this.#pending.has(id)) return id;
    }
    throw new JsonRpcPeerError("JSON-RPC request id space is exhausted.");
  }

  async #write(value: unknown): Promise<void> {
    await this.#transport.write(encodeJsonRpcFrame(value));
  }

  async #dispatch(value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null) {
      throw new JsonRpcPeerError("Invalid JSON-RPC envelope.");
    }
    const raw = value as JsonRpcValue;
    if ("id" in raw && ("result" in raw || "error" in raw)) {
      this.#dispatchResponse(raw);
      return;
    }
    if (raw.method === "$/cancel") {
      const id = (raw.params as { readonly id?: unknown } | undefined)?.id;
      if (typeof id === "number" && Number.isSafeInteger(id)) {
        this.#activeRequests
          .get(id)
          ?.abort(new JsonRpcPeerError(`JSON-RPC request ${id} was cancelled.`));
      }
      return;
    }
    const envelope = decodeEnvelope(raw);
    if (!("method" in envelope)) return;
    if ("id" in envelope) {
      if (typeof envelope.id !== "number") {
        throw new JsonRpcPeerError("Invalid JSON-RPC request id.");
      }
      void this.#dispatchRequest(envelope.id, envelope.method, envelope.params);
      return;
    }
    const handlers = this.#notifications.get(envelope.method);
    if (handlers === undefined) return;
    for (const handler of handlers) await handler(envelope.params);
  }

  #dispatchResponse(raw: JsonRpcValue): void {
    const id = raw.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if ("error" in raw) {
      const error = raw.error as {
        readonly code?: number;
        readonly message?: string;
        readonly data?: { readonly kind?: string };
      };
      pending.reject(
        new JsonRpcPeerError(error.message ?? "JSON-RPC request failed.", {
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.data?.kind === undefined ? {} : { kind: error.data.kind }),
        }),
      );
      return;
    }
    try {
      pending.resolve(decodeMethodResult(pending.method, raw.result));
    } catch (cause) {
      pending.reject(cause);
    }
  }

  async #dispatchRequest(id: number, method: RpcMethod, params: unknown): Promise<void> {
    if (this.#activeRequests.size >= MAX_PENDING_REQUESTS) {
      await this.#write({
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERROR_CODES.platform,
          message: "JSON-RPC active request limit reached.",
        },
      });
      return;
    }
    const handler = this.#requests.get(method);
    if (handler === undefined) {
      await this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR_CODES.methodNotFound, message: `Unknown method ${method}.` },
      });
      return;
    }
    const controller = new AbortController();
    this.#activeRequests.set(id, controller);
    try {
      const result = await handler(params, { id, signal: controller.signal });
      if (controller.signal.aborted || this.#closed !== undefined) return;
      await this.#write({ jsonrpc: "2.0", id, result });
    } catch (cause) {
      if (controller.signal.aborted || this.#closed !== undefined) return;
      await this.#write({
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERROR_CODES.platform,
          message: cause instanceof Error ? cause.message : String(cause),
          data: { kind: "platform" },
        },
      });
    } finally {
      if (this.#activeRequests.get(id) === controller) this.#activeRequests.delete(id);
    }
  }
}
