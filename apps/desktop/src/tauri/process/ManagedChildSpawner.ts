import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

/** The process categories understood by the host/shell process registry. */
export type ManagedChildKind = "server" | "ssh" | "wsl" | "other";

export interface ManagedChildProcessFacts {
  readonly attemptId: string;
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly kind: ManagedChildKind;
  readonly spawnedAtMs: number;
}

export interface ManagedChildRegistration {
  readonly registrationId: string | null;
}

/**
 * The small host-side boundary used by the decorator.  The implementation can
 * later be backed by the framed shell RPC without making this module aware of
 * a transport.
 */
export interface ManagedChildRegistry<
  E extends PlatformError.PlatformError = PlatformError.PlatformError,
> {
  readonly register: (
    facts: ManagedChildProcessFacts,
  ) => Effect.Effect<ManagedChildRegistration, E>;
  readonly unregister: (registrationId: string) => Effect.Effect<void, E>;
  readonly cancel: (attemptId: string) => Effect.Effect<void, E>;
}

export interface ManagedChildSpawnerOptions<
  E extends PlatformError.PlatformError = PlatformError.PlatformError,
> {
  readonly registry: ManagedChildRegistry<E>;
  readonly kind?: ManagedChildKind | ((command: ChildProcess.Command) => ManagedChildKind);
  readonly now?: () => number;
  readonly makeAttemptId?: () => string;
  /** Override the runtime platform in tests. */
  readonly platform?: NodeJS.Platform;
}

const defaultAttemptId = (() => {
  let nextId = 0;
  return (): string => {
    nextId += 1;
    return `managed-child-${String(nextId)}`;
  };
})();

const forceAttachedOnUnix = (
  command: ChildProcess.Command,
  platform: NodeJS.Platform,
): ChildProcess.Command => {
  if (platform === "win32") {
    return command;
  }

  switch (command._tag) {
    case "StandardCommand":
      return ChildProcess.make(command.command, command.args, {
        ...command.options,
        detached: false,
      });
    case "PipedCommand":
      return ChildProcess.pipeTo(
        forceAttachedOnUnix(command.left, platform),
        forceAttachedOnUnix(command.right, platform),
        command.options,
      );
  }
};

const cleanupUnregisteredChild = <E extends PlatformError.PlatformError>(
  handle: ChildProcessSpawner.ChildProcessHandle,
  registry: ManagedChildRegistry<E>,
  attemptId: string,
): Effect.Effect<void, never> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      // Killing first makes a rejected/expired registration unable to leave a
      // live direct child behind. `cancel` also removes a late shell ack.
      yield* handle.kill().pipe(Effect.ignore);
      yield* registry.cancel(attemptId).pipe(Effect.ignore);
    }),
  );

/**
 * Decorate the one host `ChildProcessSpawner` boundary with managed-child
 * registration.  `ChildProcessSpawner.make` is intentionally used here: its
 * derived helpers call the supplied `spawn`, so none can bypass registration.
 */
export const decorateManagedChildSpawner = <E extends PlatformError.PlatformError>(
  delegate: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: ManagedChildSpawnerOptions<E>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  const semaphore = Semaphore.makeUnsafe(1);
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const makeAttemptId = options.makeAttemptId ?? defaultAttemptId;

  const spawn = (command: ChildProcess.Command) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const attemptId = makeAttemptId();
        const handle = yield* delegate.spawn(forceAttachedOnUnix(command, platform));
        const spawnedAtMs = now();
        const kind =
          typeof options.kind === "function" ? options.kind(command) : (options.kind ?? "other");

        const registration = yield* options.registry
          .register({
            attemptId,
            pid: handle.pid,
            kind,
            spawnedAtMs,
          })
          .pipe(
            Effect.onInterrupt(() => cleanupUnregisteredChild(handle, options.registry, attemptId)),
            Effect.catch((error) =>
              cleanupUnregisteredChild(handle, options.registry, attemptId).pipe(
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          );

        if (registration.registrationId === null) {
          return handle;
        }

        const registrationId = registration.registrationId;
        const unregister = yield* Effect.cached(
          options.registry.unregister(registrationId).pipe(Effect.ignore),
        );

        // Scope finalizers run in reverse registration order. Explicitly close
        // the child before unregistering so a scope shutdown cannot leave a
        // registry entry pointing at a live process.
        const scope = yield* Scope.Scope;
        yield* Scope.addFinalizer(
          scope,
          Effect.uninterruptible(
            handle.kill().pipe(
              Effect.ignore,
              Effect.andThen(
                handle.exitCode.pipe(
                  Effect.flatMap(() => unregister),
                  Effect.ignore,
                ),
              ),
            ),
          ),
        );
        yield* handle.exitCode.pipe(
          Effect.flatMap(() => Effect.uninterruptible(unregister)),
          Effect.ignore,
          Effect.forkScoped,
        );

        return handle;
      }),
    );

  return ChildProcessSpawner.make(spawn);
};
