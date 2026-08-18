import * as DesktopIpc from "../../ipc/DesktopIpc.ts";

export interface TauriIpcMain extends DesktopIpc.DesktopIpcMain {
  /** Test/bridge hook for invoking a registered asynchronous handler. */
  readonly invoke: (channel: string, raw: unknown) => Promise<unknown>;
  /** Test/bridge hook for dispatching registered synchronous listeners. */
  readonly invokeSync: (channel: string) => unknown;
}

type SyncListener = DesktopIpc.DesktopIpcSyncListener;

const missingHandlerError = (channel: string): Error =>
  new Error(`No invoke handler registered for channel '${channel}'.`);

export const make = (): TauriIpcMain => {
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const listeners = new Map<string, Array<SyncListener>>();

  const invoke = async (channel: string, raw: unknown): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw missingHandlerError(channel);
    }

    return handler({}, raw);
  };

  const invokeSync = (channel: string): unknown => {
    const event: DesktopIpc.DesktopIpcSyncEvent = { returnValue: undefined };
    const channelListeners = listeners.get(channel);
    if (channelListeners === undefined) {
      return event.returnValue;
    }

    for (const listener of [...channelListeners]) {
      listener(event);
    }

    return event.returnValue;
  };

  return {
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeAllListeners: (channel) => {
      listeners.delete(channel);
    },
    on: (channel, listener) => {
      const channelListeners = listeners.get(channel);
      if (channelListeners === undefined) {
        listeners.set(channel, [listener]);
      } else {
        channelListeners.push(listener);
      }
    },
    invoke,
    invokeSync,
  };
};

export const layer = (ipcMain: DesktopIpc.DesktopIpcMain = make()) => DesktopIpc.layer(ipcMain);
