import { assert, describe, it } from "@effect/vitest";

import * as TauriIpcMain from "./TauriIpcMain.ts";

describe("TauriIpcMain", () => {
  it("replaces invoke handlers and dispatches through the test hook", async () => {
    const ipcMain = TauriIpcMain.make();
    const first = () => "first";
    const second = async (_event: object, raw: unknown) => ({ raw });

    ipcMain.handle("desktop:test", first);
    assert.strictEqual(await ipcMain.invoke("desktop:test", "ignored"), "first");

    ipcMain.handle("desktop:test", second);
    assert.deepEqual(await ipcMain.invoke("desktop:test", 42), { raw: 42 });

    ipcMain.removeHandler("desktop:test");
    try {
      await ipcMain.invoke("desktop:test", undefined);
      throw new Error("expected invoke to reject");
    } catch (error) {
      assert.match(String(error), /No invoke handler/);
    }
  });

  it("dispatches sync listeners in registration order and removes them as a group", () => {
    const ipcMain = TauriIpcMain.make();
    const calls: string[] = [];

    ipcMain.on("desktop:test-sync", (event) => {
      calls.push("first");
      event.returnValue = "first";
    });
    ipcMain.on("desktop:test-sync", (event) => {
      calls.push("second");
      event.returnValue = "second";
    });

    assert.strictEqual(ipcMain.invokeSync("desktop:test-sync"), "second");
    assert.deepEqual(calls, ["first", "second"]);

    ipcMain.removeAllListeners("desktop:test-sync");
    assert.isUndefined(ipcMain.invokeSync("desktop:test-sync"));
  });

  it("exposes the existing DesktopIpc layer", async () => {
    const ipcMain = TauriIpcMain.make();
    const layer = TauriIpcMain.layer(ipcMain);

    ipcMain.handle("desktop:test", (_event, raw) => raw);
    assert.strictEqual(await ipcMain.invoke("desktop:test", "ok"), "ok");
    assert.isNotNull(layer);
  });
});
