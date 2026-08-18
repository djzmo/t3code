import { assert, describe, it } from "@effect/vitest";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";

import * as TauriApp from "../electron/TauriApp.ts";
import { make } from "./FakeShell.ts";

const facts = {
  attemptId: "backend-attempt",
  pid: ChildProcessSpawner.ProcessId(123),
  kind: "server" as const,
  spawnedAtMs: 10,
};

describe("FakeShell", () => {
  it.effect("implements hello, app requests, and notifications with an audit", () =>
    Effect.gen(function* () {
      const fake = make({ registeredProtocolSchemes: ["agent-nanoni"] });
      const app = TauriApp.make(fake.app, { hostPid: 42 });

      assert.strictEqual(yield* app.name, "Agent Nanoni");
      assert.isTrue(yield* app.isDefaultProtocolClient("agent-nanoni"));
      assert.isTrue(yield* app.setAsDefaultProtocolClient("agent-nanoni-dev"));
      yield* app.quit;

      assert.deepEqual(fake.audit.hello, [{ protocolVersion: "2.0", hostPid: 42 }]);
      assert.deepEqual(
        fake.audit.requests.map(({ method, params }) => ({ method, params })),
        [
          { method: "app.isProtocolClient", params: { scheme: "agent-nanoni" } },
          { method: "app.setProtocolClient", params: { scheme: "agent-nanoni-dev" } },
        ],
      );
      assert.deepEqual(fake.audit.notifications, [{ method: "app.quit", params: {} }]);
    }),
  );

  it("emits scoped app events and returns a synchronous before-quit response", () => {
    const fake = make();
    let calls = 0;
    const remove = fake.on("app.before-quit", () => {
      calls += 1;
      return { prevented: true };
    });

    assert.deepEqual(fake.emit("app.before-quit", { reason: "user" }), { prevented: true });
    assert.strictEqual(calls, 1);
    remove();
    assert.deepEqual(fake.emit("app.before-quit", { reason: "host" }), { prevented: false });
    assert.strictEqual(calls, 1);
    assert.deepEqual(fake.audit.events, [
      { method: "app.before-quit", params: { reason: "user" }, result: { prevented: true } },
      { method: "app.before-quit", params: { reason: "host" }, result: { prevented: false } },
    ]);
  });

  it.effect("registers, unregisters, and cancels managed children deterministically", () =>
    Effect.gen(function* () {
      const fake = make({ nullRegistrationAttempts: ["already-exited"] });
      const registered = yield* fake.register(facts);
      assert.deepEqual(registered, { registrationId: "registration-1" });
      assert.deepEqual(fake.activeRegistrations, [{ ...facts, registrationId: "registration-1" }]);

      yield* fake.unregister("registration-1");
      assert.isEmpty(fake.activeRegistrations);

      const noRegistration = yield* fake.register({ ...facts, attemptId: "already-exited" });
      assert.deepEqual(noRegistration, { registrationId: null });
      assert.isEmpty(fake.activeRegistrations);
      yield* fake.cancel("already-exited");
      assert.deepEqual(fake.audit.unregistrations, [{ registrationId: "registration-1" }]);
      assert.deepEqual(fake.audit.cancellations, [{ attemptId: "already-exited" }]);
    }),
  );

  it.effect("captures ipc pushes and host notifications", () =>
    Effect.gen(function* () {
      const fake = make();
      yield* Effect.promise(() =>
        fake.notify("ipc.push", { channel: "desktop:ready", payload: { ok: true } }),
      );
      yield* Effect.promise(() => fake.notify("app.shutdown-complete", {}));

      assert.deepEqual(fake.ipcPushes, [{ channel: "desktop:ready", payload: { ok: true } }]);
      assert.deepEqual(fake.notifications, [
        { method: "ipc.push", params: { channel: "desktop:ready", payload: { ok: true } } },
        { method: "app.shutdown-complete", params: {} },
      ]);
    }),
  );
});
