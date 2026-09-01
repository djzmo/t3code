const unavailable = (member: string): never => {
  throw new Error(`Electron API ${JSON.stringify(member)} is unavailable in the Tauri host.`);
};

const autoUpdater = new Proxy(
  {},
  {
    get: (_target, property) => unavailable(`electron-updater.autoUpdater.${String(property)}`),
  },
);

export { autoUpdater };
export default autoUpdater;
