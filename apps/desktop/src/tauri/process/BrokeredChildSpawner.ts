import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import { type ManagedChildKind } from "./ManagedChildSpawner.ts";
import { type ProcessSpawnParams, type RpcProcessBroker } from "./RpcProcessBroker.ts";

export interface BrokeredChildSpawnerOptions {
  readonly broker: RpcProcessBroker;
  readonly kind?: ManagedChildKind | ((command: ChildProcess.Command) => ManagedChildKind);
  readonly makeAttemptId?: () => string;
  readonly platform?: NodeJS.Platform;
}

const defaultAttemptId = (() => {
  let next = 0;
  return (): string => {
    next += 1;
    return `brokered-child-${String(next)}`;
  };
})();

const invalid = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: "brokered-child-spawner",
    method,
    description,
  });

const pipeMode = (
  value: ChildProcess.CommandInput | ChildProcess.CommandOutput | undefined,
  method: string,
): "pipe" | "null" => {
  const mode = typeof value === "object" ? undefined : value;
  if (mode === undefined || mode === "pipe") return "pipe";
  if (mode === "ignore") return "null";
  throw invalid(method, `stream mode '${String(mode)}' is not transport-representable`);
};

const configuredStream = (
  value:
    | ChildProcess.CommandInput
    | ChildProcess.CommandOutput
    | ChildProcess.StdinConfig
    | ChildProcess.StdoutConfig
    | ChildProcess.StderrConfig
    | undefined,
  method: string,
): ChildProcess.CommandInput | ChildProcess.CommandOutput | undefined => {
  if (value === undefined || typeof value !== "object" || Stream.isStream(value)) return value;
  if ("stream" in value) {
    return (value as { readonly stream?: unknown }).stream as
      | ChildProcess.CommandInput
      | ChildProcess.CommandOutput
      | undefined;
  }
  throw invalid(method, "embedded stream or sink is not transport-representable");
};

const stdinInputStream = (
  value: ChildProcess.CommandInput | undefined,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> | undefined =>
  Stream.isStream(value)
    ? (value as Stream.Stream<Uint8Array, PlatformError.PlatformError>)
    : undefined;

interface InputFdStream {
  readonly fd: number;
  readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}

interface AdditionalFdsResult {
  readonly fds: ProcessSpawnParams["additionalFds"];
  readonly inputStreams: ReadonlyArray<InputFdStream>;
}

const additionalFds = (
  value: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> | undefined,
): AdditionalFdsResult => {
  if (value === undefined) return { fds: [], inputStreams: [] };
  const inputStreams: Array<InputFdStream> = [];
  const fds = Object.entries(value)
    .map(([name, config]) => {
      const match = /^fd([0-9]+)$/.exec(name);
      const fd = match === null ? Number.NaN : Number(match[1]);
      if (!Number.isSafeInteger(fd) || fd < 3) {
        throw invalid("spawn", `additional fd '${name}' must be an integer >= 3`);
      }
      if (config.type === "input") {
        if (config.stream !== undefined) inputStreams.push({ fd, stream: config.stream });
        return { fd, direction: "input" as const };
      }
      if (config.sink !== undefined) {
        throw invalid("spawn", `additional fd '${name}' embeds an unsupported sink`);
      }
      return { fd, direction: "output" as const };
    })
    .sort((left, right) => left.fd - right.fd);
  inputStreams.sort((left, right) => left.fd - right.fd);
  return { fds, inputStreams };
};

interface BrokerSpawnRequest {
  readonly params: ProcessSpawnParams;
  readonly stdinStream: Stream.Stream<Uint8Array, PlatformError.PlatformError> | undefined;
  readonly inputStreams: ReadonlyArray<InputFdStream>;
}

const toSpawnRequest = (
  command: ChildProcess.StandardCommand,
  options: BrokeredChildSpawnerOptions,
): BrokerSpawnRequest => {
  const commandOptions = command.options;
  if (commandOptions.shell !== undefined && commandOptions.shell !== false) {
    throw invalid("spawn", "shell execution is not supported by the process broker");
  }
  if (commandOptions.detached === true) {
    throw invalid("spawn", "detached processes are not supported by the process broker");
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(commandOptions.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }

  const stdin = configuredStream(commandOptions.stdin, "stdin");
  const stdout = configuredStream(commandOptions.stdout, "stdout");
  const stderr = configuredStream(commandOptions.stderr, "stderr");
  const kind =
    typeof options.kind === "function" ? options.kind(command) : (options.kind ?? "other");
  const attemptId = (options.makeAttemptId ?? defaultAttemptId)();
  if (attemptId.length === 0) throw invalid("spawn", "attempt id must be non-empty");
  const configuredAdditionalFds = additionalFds(commandOptions.additionalFds);

  return {
    params: {
      attemptId,
      kind,
      command: command.command,
      args: [...command.args],
      ...(commandOptions.cwd === undefined ? {} : { cwd: commandOptions.cwd }),
      env,
      extendEnv: commandOptions.extendEnv === true,
      stdin: pipeMode(stdin, "stdin"),
      stdout: pipeMode(stdout, "stdout"),
      stderr: pipeMode(stderr, "stderr"),
      additionalFds: configuredAdditionalFds.fds,
    },
    stdinStream: stdinInputStream(stdin as ChildProcess.CommandInput | undefined),
    inputStreams: configuredAdditionalFds.inputStreams,
  };
};

export const makeBrokeredChildSpawner = (
  options: BrokeredChildSpawnerOptions,
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  const spawn = (
    command: ChildProcess.Command,
  ): Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    import("effect/Scope").Scope
  > => {
    if (command._tag === "PipedCommand") {
      return Effect.fail(
        invalid("spawn", "piped commands are not supported by the process broker"),
      );
    }
    return Effect.gen(function* () {
      const request = toSpawnRequest(command, options);
      const result = yield* options.broker
        .spawn(request.params)
        .pipe(
          Effect.mapError((error) =>
            error instanceof PlatformError.PlatformError ? error : invalid("spawn", error.message),
          ),
        );
      if (result._tag === "fast-exit") return result.handle;

      // Match the native Effect spawner: input streams are started only after
      // the child handle exists, and each pump is tied to the caller's scope.
      if (request.stdinStream !== undefined) {
        yield* Stream.run(request.stdinStream, result.handle.stdin).pipe(Effect.forkScoped);
      }
      yield* Effect.forEach(
        request.inputStreams,
        ({ fd, stream }) =>
          Stream.run(stream, result.handle.getInputFd(fd)).pipe(Effect.forkScoped),
        { discard: true },
      );
      return result.handle;
    });
  };
  return ChildProcessSpawner.make(spawn);
};
