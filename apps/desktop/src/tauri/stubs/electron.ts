/**
 * Electron is intentionally unavailable in the Tauri host bundle.
 *
 * `screen.getAllDisplays` is the one read-only compatibility seam retained
 * for the shared DesktopWindow bootstrap. Every other member fails when it is
 * touched so an accidental Electron path cannot silently run in Tauri.
 */
const unavailable = (member: string): never => {
  throw new Error(`Electron API ${JSON.stringify(member)} is unavailable in the Tauri host.`);
};

const throwingMember = (member: string) =>
  new Proxy(
    function unavailableElectronMember(..._args: readonly unknown[]): never {
      return unavailable(member);
    },
    {
      apply: () => unavailable(member),
      construct: () => unavailable(member),
      get: (_target, property) => unavailable(`${member}.${String(property)}`),
    },
  );

const displayBounds = Object.freeze({ x: 0, y: 0, width: 1920, height: 1080 });

export const screen = new Proxy(
  {
    getAllDisplays: () => [{ bounds: displayBounds }],
  },
  {
    get: (target, property, receiver) => {
      if (property === "getAllDisplays") {
        return Reflect.get(target, property, receiver);
      }
      return unavailable(`screen.${String(property)}`);
    },
  },
);

export const app = throwingMember("app");
export const autoUpdater = throwingMember("autoUpdater");
export const BrowserWindow = throwingMember("BrowserWindow");
export const clipboard = throwingMember("clipboard");
export const contextBridge = throwingMember("contextBridge");
export const dialog = throwingMember("dialog");
export const ipcMain = throwingMember("ipcMain");
export const ipcRenderer = throwingMember("ipcRenderer");
export const Menu = throwingMember("Menu");
export const nativeImage = throwingMember("nativeImage");
export const nativeTheme = throwingMember("nativeTheme");
export const net = Object.freeze({
  fetch: (..._args: readonly unknown[]): never => unavailable("net.fetch"),
});
export const powerMonitor = throwingMember("powerMonitor");
export const protocol = throwingMember("protocol");
export const safeStorage = Object.freeze({
  isEncryptionAvailable: (): never => unavailable("safeStorage.isEncryptionAvailable"),
  encryptString: (..._args: readonly unknown[]): never => unavailable("safeStorage.encryptString"),
  decryptString: (..._args: readonly unknown[]): never => unavailable("safeStorage.decryptString"),
  getSelectedStorageBackend: (): never => unavailable("safeStorage.getSelectedStorageBackend"),
});
export const session = throwingMember("session");
export const shell = throwingMember("shell");
export const webContents = throwingMember("webContents");

const electronModule = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === "screen") {
        return screen;
      }
      return unavailable(`electron.${String(property)}`);
    },
  },
);

export default electronModule;
