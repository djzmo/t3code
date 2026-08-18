import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import fixtureDocument from "./fixtures/protocol-fixtures.json" with { type: "json" };
import {
  APPENDIX_B_METHODS,
  APPENDIX_B_METHOD_SPECS,
  JSON_RPC_VERSION,
  MAX_FRAME_BYTES,
  MAX_NESTING_DEPTH,
  MAX_PENDING_REQUESTS,
  PRE_READY_RENDERER_QUEUE_LIMIT,
  PROCESS_BROKER_METHODS,
  RPC_METHOD_SPECS,
  RpcEnvelope,
  RpcMethodName,
  RpcResponse,
  decodeMethodParams,
  decodeMethodResult,
  decodeEnvelope,
  decodeFixtureDocument,
  encodeEnvelope,
} from "./protocol.ts";

const document = decodeFixtureDocument(fixtureDocument);

describe("Tauri shell/host RPC contract", () => {
  it("validates the native process-broker containment amendment", () => {
    const envelopes = [
      {
        jsonrpc: "2.0",
        id: 900,
        method: "process.spawn",
        params: {
          attemptId: "attempt-1",
          kind: "server",
          command: "node",
          args: ["server.cjs"],
          env: {},
          extendEnv: true,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          additionalFds: [{ fd: 3, direction: "output" }],
        },
      },
      {
        jsonrpc: "2.0",
        method: "process.input",
        params: {
          processId: "process-1",
          registrationId: "registration-1",
          fd: 0,
          bytesBase64: "aGVsbG8=",
        },
      },
      {
        jsonrpc: "2.0",
        method: "process.kill",
        params: {
          processId: "process-1",
          registrationId: "registration-1",
          signal: "SIGTERM",
          forceKillAfterMs: 5_000,
        },
      },
      {
        jsonrpc: "2.0",
        method: "process.release",
        params: { processId: "process-1", registrationId: "registration-1" },
      },
      {
        jsonrpc: "2.0",
        method: "process.output",
        params: { processId: "process-1", fd: 1, sequence: 0, bytesBase64: "b2s=" },
      },
      {
        jsonrpc: "2.0",
        method: "process.exit",
        params: { processId: "process-1", code: 0 },
      },
    ] as const;

    assert.equal(envelopes.length, PROCESS_BROKER_METHODS.length);
    for (const envelope of envelopes) decodeEnvelope(envelope);

    assert.throws(() =>
      decodeEnvelope({
        jsonrpc: "2.0",
        method: "process.spawn",
        params: envelopes[0].params,
      }),
    );
  });

  it("decodes every Appendix B fixture and covers every method exactly once", () => {
    const fixtureMethods = new Set(
      document.fixtures.flatMap((fixture) =>
        "method" in fixture.envelope ? [fixture.envelope.method] : [],
      ),
    );

    assert.equal(fixtureMethods.size, APPENDIX_B_METHODS.length);
    for (const method of APPENDIX_B_METHODS) {
      assert.isTrue(fixtureMethods.has(method), `missing fixture for ${method}`);
    }
  });

  it("round-trips envelopes semantically", () => {
    for (const fixture of document.fixtures) {
      const decoded = decodeEnvelope(fixture.envelope);
      const encoded = encodeEnvelope(decoded);
      assert.deepStrictEqual(decodeEnvelope(encoded), decoded, fixture.name);
    }
  });

  it("matches Appendix B direction and request/notification kind metadata", () => {
    for (const fixture of document.fixtures) {
      if (!("method" in fixture.envelope)) {
        assert.equal(fixture.kind, "response", fixture.name);
        continue;
      }

      const spec = RPC_METHOD_SPECS[fixture.envelope.method];
      assert.equal(fixture.direction, spec.direction, fixture.name);
      assert.equal(fixture.kind, spec.kind, fixture.name);
      assert.equal("id" in fixture.envelope, spec.kind === "request", fixture.name);
      decodeMethodParams(
        fixture.envelope.method,
        "params" in fixture.envelope ? fixture.envelope.params : undefined,
      );
    }
  });

  it("decodes positive result fixtures with their method-specific contracts", () => {
    const coveredMethods = new Set<string>();
    for (const fixture of document.results) {
      const response = Schema.decodeUnknownSync(RpcResponse)(fixture.envelope);
      assert.isTrue("result" in response, fixture.name);
      if (!("result" in response)) continue;
      assert.equal(fixture.kind, "response", fixture.name);
      const requestSpec = RPC_METHOD_SPECS[fixture.method];
      assert.equal(
        fixture.direction,
        requestSpec.direction === "host-to-shell" ? "shell-to-host" : "host-to-shell",
        fixture.name,
      );
      const decodedResult = decodeMethodResult(fixture.method, response.result);
      assert.deepStrictEqual(decodedResult, response.result, fixture.name);
      coveredMethods.add(fixture.method);
    }

    assert.isAtLeast(coveredMethods.size, 12);
    for (const method of [
      "app.getMetrics",
      "process.register",
      "ipc.invoke",
      "window.getBounds",
      "dialog.openFiles",
      "menu.popup",
      "shell.openExternal",
      "wsl.registerGuest",
      "theme.get",
      "safeStorage.encrypt",
      "updater.check",
      "power.snapshot",
    ] as const) {
      assert.isTrue(coveredMethods.has(method), `missing result fixture for ${method}`);
    }

    const requestMethods = APPENDIX_B_METHODS.filter(
      (method) => APPENDIX_B_METHOD_SPECS[method].kind === "request",
    );
    for (const method of requestMethods) {
      assert.isTrue(coveredMethods.has(method), `missing result fixture for request ${method}`);
    }
  });

  it("rejects representative wrong params and results for every method family", () => {
    const invalidParams: ReadonlyArray<readonly [(typeof APPENDIX_B_METHODS)[number], unknown]> = [
      ["app.exit", { code: "0" }],
      ["process.register", { attemptId: "attempt", pid: "7001", kind: "server", spawnedAtMs: 1 }],
      ["ipc.invoke", { channel: 42, payload: null }],
      ["window.setBounds", { label: "main", x: 0, y: 0, width: "1200", height: 800 }],
      ["dialog.message", { kind: "info", message: "Ready", buttons: "OK" }],
      ["menu.popup", { ownerLabel: 42, items: [] }],
      ["shell.openExternal", { url: 42 }],
      [
        "wsl.registerGuest",
        { instanceId: "wsl", distro: "Ubuntu", nonce: "n", identityFile: "x", state: "unknown" },
      ],
      ["theme.setSource", { source: 42 }],
      ["safeStorage.encrypt", { plaintext: 42 }],
      [
        "updater.configure",
        { endpoints: "https://updates.example.com", channel: "stable", allowDowngrade: false },
      ],
      ["power.event", { type: 42, value: true }],
    ];
    for (const [method, params] of invalidParams) {
      assert.throws(() => decodeMethodParams(method, params));
    }

    const invalidResults: ReadonlyArray<readonly [(typeof APPENDIX_B_METHODS)[number], unknown]> = [
      ["app.isProtocolClient", { registered: "yes" }],
      ["process.register", { registrationId: 1 }],
      ["ipc.invoke", []],
      ["window.getBounds", { x: 0 }],
      ["dialog.openFiles", { paths: "README.md" }],
      ["menu.popup", { selectedId: 1 }],
      ["shell.openExternal", { ok: "yes" }],
      ["wsl.registerGuest", { ok: "yes" }],
      ["theme.get", { shouldUseDarkColors: "yes" }],
      ["safeStorage.encrypt", { ciphertextBase64: 1 }],
      ["updater.check", { available: "yes" }],
      ["power.snapshot", { onBattery: "yes" }],
    ];
    for (const [method, result] of invalidResults) {
      assert.throws(() => decodeMethodResult(method, result));
    }
  });

  it("accepts both request/notification directions and response errors", () => {
    const tags = new Set(document.fixtures.map((fixture) => fixture.kind));
    assert.deepStrictEqual(tags, new Set(["request", "notification", "response"]));
    assert.equal(document.errors.length, 7);
    for (const error of document.errors) {
      assert.equal(error.envelope.jsonrpc, JSON_RPC_VERSION);
      if (error.expectKind === "invalid-request") {
        assert.isUndefined(error.envelope.error.data);
      } else {
        assert.equal(
          error.envelope.error.data?.kind,
          error.expectKind === "method-not-found" ? "unsupported" : error.expectKind,
        );
      }
    }
  });

  it("keeps the frozen limits in fixture metadata", () => {
    const limits = new Map(document.limits.map((limit) => [limit.name, limit]));
    assert.equal(limits.get("max-frame-bytes")?.limit, MAX_FRAME_BYTES);
    assert.equal(limits.get("max-nesting-depth")?.limit, MAX_NESTING_DEPTH);
    assert.equal(limits.get("pending-request-capacity")?.limit, MAX_PENDING_REQUESTS);
    assert.equal(limits.get("pre-ready-renderer-queue")?.limit, PRE_READY_RENDERER_QUEUE_LIMIT);
    assert.equal(limits.get("hello-timeout")?.limit, 15_000);
  });

  it("represents invalid byte cases without lossy UTF-8 coercion", () => {
    const invalidUtf8 = document.frames.find((frame) => frame.name === "invalid-utf8");
    assert.isDefined(invalidUtf8);
    assert.equal(invalidUtf8.bytesBase64, "//4=");
    assert.isUndefined(invalidUtf8.frame);

    const splitCodePoint = document.frames.find((frame) => frame.name === "split-utf8-codepoint");
    assert.isDefined(splitCodePoint);
    assert.isDefined(splitCodePoint.bytes);
    assert.isUndefined(splitCodePoint.bytesBase64);
  });

  it("keeps accepted frame lengths equal to their UTF-8 payload bytes", () => {
    const encoder = new TextEncoder();
    for (const fixture of document.frames) {
      if (fixture.expect !== "accept" || fixture.frame === undefined) continue;
      const match = /^\x1e(\d+):([\s\S]*)\n$/.exec(fixture.frame);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        assert.fail(`${fixture.name} is not a complete frame`);
      }
      assert.equal(Number(match[1]), encoder.encode(match[2]).byteLength, fixture.name);
    }
  });

  it("rejects unknown method names and malformed envelopes", () => {
    assert.throws(() => Schema.decodeUnknownSync(RpcMethodName)("unknown.method"));
    assert.throws(() =>
      Schema.decodeUnknownSync(RpcEnvelope)({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "unknown.method",
        params: {},
      }),
    );
  });

  it("rejects envelopes whose id presence disagrees with Appendix B kind", () => {
    const invalidKinds = [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 200,
        method: "app.exit",
        params: { code: 0 },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "shell.hello",
        params: { protocolVersion: JSON_RPC_VERSION, hostPid: 4242 },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "window.getBounds",
        params: { label: "main" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 201,
        method: "app.open-url",
        params: { urls: ["agent-nanoni://callback"] },
      },
    ] as const;

    for (const [index, envelope] of invalidKinds.entries()) {
      let accepted = false;
      try {
        decodeEnvelope(envelope);
        accepted = true;
      } catch {
        // expected
      }
      assert.isFalse(accepted, `invalid kind ${index} was accepted`);
    }
  });
});
