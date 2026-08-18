// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as TauriEnvironment from "./TauriEnvironment.ts";

const identity: TauriEnvironment.TauriEnvironmentIdentity = {
  branding: {
    baseName: "Test Product",
    stageLabel: "Dev",
    displayName: "Test Product (Dev)",
  },
  displayName: "Test Product (Dev)",
  appUserModelId: "com.example.test.dev",
  linuxDesktopEntryName: "test-product-dev.desktop",
  linuxWmClass: "test-product-dev",
  userDataDirName: "agent-nanoni-dev",
  legacyUserDataDirName: "Agent Nanoni (Dev)",
};

const defaultInput = {
  dirname: "C:/worktree/apps/desktop/dist-tauri",
  homeDirectory: "C:/Users/alice",
  platform: "win32",
  processArch: "x64",
  appVersion: "1.0.0-dev",
  appPath: "C:/worktree/apps/desktop/dist-tauri/host.cjs",
  isPackaged: false,
  resourcesPath: "C:/worktree/resources",
  runningUnderArm64Translation: false,
  identity,
} satisfies TauriEnvironment.TauriEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<TauriEnvironment.TauriEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  TauriEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(DesktopConfig.layerTest(env)));

const makeEnvironment = (
  overrides: Partial<TauriEnvironment.TauriEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => TauriEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

const portable = (value: string): string => value.replaceAll("\\", "/");

describe("TauriEnvironment", () => {
  it.effect("keeps the injected identity and worktree root in development", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(portable(environment.rootDir), "C:/worktree");
      assert.equal(portable(environment.appRoot), "C:/worktree");
      assert.equal(portable(environment.serverRoot), "C:/worktree");
      assert.equal(portable(environment.backendEntryPath), "C:/worktree/apps/server/dist/bin.mjs");
      assert.equal(environment.homeDirectory, "C:/Users/alice");
      assert.deepEqual(environment.branding, identity.branding);
      assert.equal(environment.displayName, identity.displayName);
      assert.equal(environment.appUserModelId, identity.appUserModelId);
      assert.equal(environment.linuxDesktopEntryName, identity.linuxDesktopEntryName);
      assert.equal(environment.linuxWmClass, identity.linuxWmClass);
      assert.equal(environment.userDataDirName, identity.userDataDirName);
      assert.equal(environment.legacyUserDataDirName, identity.legacyUserDataDirName);
    }),
  );

  it.effect("derives the packaged staged server root and backend entry", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        isPackaged: true,
        appPath: "C:/Program Files/AgentNanoni/AgentNanoni.exe",
        resourcesPath: "C:/Program Files/AgentNanoni/resources",
      });

      assert.equal(portable(environment.appRoot), "C:/Program Files/AgentNanoni/resources/server");
      assert.equal(
        portable(environment.serverRoot),
        "C:/Program Files/AgentNanoni/resources/server",
      );
      assert.equal(
        portable(environment.backendEntryPath),
        "C:/Program Files/AgentNanoni/resources/server/apps/server/dist/bin.mjs",
      );
      assert.equal(
        portable(environment.appUpdateYmlPath),
        "C:/Program Files/AgentNanoni/resources/app-update.yml",
      );
      assert.equal(portable(environment.backendCwd), "C:/Users/alice");
      assert.equal(
        portable(environment.preloadPath),
        "C:/worktree/apps/desktop/dist-tauri/preload.cjs",
      );
    }),
  );

  it("does not import Electron runtime APIs", () => {
    const source = readFileSync(new URL("./TauriEnvironment.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /require\(["']electron["']\)/);
  });
});
