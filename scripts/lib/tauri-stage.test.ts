// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { strict as assert } from "node:assert";

import { describe, it } from "@effect/vitest";

import { TauriStageError, assertClerkAbsent, stageTauriResources } from "./tauri-stage.ts";

const makeFixture = async () => {
  const root = await NodeFS.mkdtemp(NodePath.join(process.cwd(), ".tauri-stage-test-"));
  const server = NodePath.join(root, "server-closure");
  const host = NodePath.join(root, "host.cjs");
  const monitor = NodePath.join(root, "t3-resource-monitor");
  const licenses = NodePath.join(root, "licenses");
  const update = NodePath.join(root, "app-update.yml");
  const web = NodePath.join(root, "web");
  const stage = NodePath.join(root, "stage");

  await NodeFS.mkdir(NodePath.join(server, "apps/server/dist"), { recursive: true });
  await NodeFS.mkdir(NodePath.join(server, "node_modules/example"), { recursive: true });
  await NodeFS.mkdir(licenses, { recursive: true });
  await NodeFS.mkdir(web, { recursive: true });
  await NodeFS.writeFile(NodePath.join(server, "apps/server/dist/bin.mjs"), "export {};\n");
  await NodeFS.writeFile(
    NodePath.join(server, "node_modules/example/index.js"),
    "module.exports = 1;\n",
  );
  await NodeFS.writeFile(host, "#!/usr/bin/env node\n");
  await NodeFS.writeFile(monitor, "monitor\n");
  await NodeFS.writeFile(NodePath.join(licenses, "node.txt"), "Node license\n");
  await NodeFS.writeFile(update, "provider: latest\n");
  await NodeFS.writeFile(NodePath.join(web, "index.html"), "<!doctype html>\n");

  return { root, server, host, monitor, licenses, update, web, stage };
};

const removeFixture = async (root: string) => {
  await NodeFS.rm(root, { recursive: true, force: true });
};

describe("tauri resource staging", () => {
  it("publishes the deterministic resource layout and product environment", async () => {
    const fixture = await makeFixture();
    try {
      await NodeFS.mkdir(fixture.stage, { recursive: true });
      await NodeFS.writeFile(NodePath.join(fixture.stage, "stale.txt"), "stale\n");

      const result = await stageTauriResources({
        stageRoot: fixture.stage,
        serverClosurePath: fixture.server,
        hostBundlePath: fixture.host,
        resourceMonitorPath: fixture.monitor,
        licensesPath: fixture.licenses,
        appUpdateManifestPath: fixture.update,
        clerkScanPaths: [fixture.web],
        productVersion: "1.2.3",
        environment: { CI: "1" },
      });

      assert.equal(result.productVersion, "1.2.3");
      assert.equal(result.environment.NANONI_PRODUCT_VERSION, "1.2.3");
      assert.equal(
        await NodeFS.readFile(
          NodePath.join(fixture.stage, "server/apps/server/dist/bin.mjs"),
          "utf8",
        ),
        "export {};\n",
      );
      assert.equal(
        await NodeFS.readFile(NodePath.join(fixture.stage, "host/host.cjs"), "utf8"),
        "#!/usr/bin/env node\n",
      );
      assert.equal(
        await NodeFS.readFile(
          NodePath.join(fixture.stage, "resource-monitor/t3-resource-monitor"),
          "utf8",
        ),
        "monitor\n",
      );
      assert.equal(
        await NodeFS.readFile(NodePath.join(fixture.stage, "licenses/node.txt"), "utf8"),
        "Node license\n",
      );
      assert.equal(
        await NodeFS.readFile(NodePath.join(fixture.stage, "app-update.yml"), "utf8"),
        "provider: latest\n",
      );
      await assert.rejects(NodeFS.access(NodePath.join(fixture.stage, "stale.txt")));
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("fails before staging when Clerk is configured", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        assertClerkAbsent([], { VITE_CLERK_PUBLISHABLE_KEY: "pk_test_fixture" }),
        (error: unknown) =>
          error instanceof TauriStageError &&
          error.code === "clerk-config-present" &&
          error.message.includes("VITE_CLERK_PUBLISHABLE_KEY"),
      );

      await NodeFS.writeFile(
        NodePath.join(fixture.web, "index.js"),
        "const key = 'pk_live_fixture';\n",
      );
      await assert.rejects(
        assertClerkAbsent([fixture.web], {}),
        (error: unknown) =>
          error instanceof TauriStageError && error.code === "clerk-config-present",
      );
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("rejects missing source paths without creating a partial stage", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        stageTauriResources({
          stageRoot: fixture.stage,
          serverClosurePath: NodePath.join(fixture.root, "missing-server"),
          hostBundlePath: fixture.host,
          resourceMonitorPath: fixture.monitor,
          productVersion: "1.2.3",
        }),
        (error: unknown) => error instanceof TauriStageError && error.code === "missing-source",
      );
      await assert.rejects(NodeFS.access(fixture.stage));
    } finally {
      await removeFixture(fixture.root);
    }
  });
});
