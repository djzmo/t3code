const unavailable = (member: string): never => {
  throw new Error(`Clerk Electron API ${JSON.stringify(member)} is unavailable in the Tauri host.`);
};

export const createClerkBridge = (..._args: readonly unknown[]): never =>
  unavailable("createClerkBridge");

export const exposeClerkBridge = (..._args: readonly unknown[]): never =>
  unavailable("exposeClerkBridge");

export const storage = (..._args: readonly unknown[]): never => unavailable("storage");

const clerkModule = new Proxy(
  {},
  {
    get: (_target, property) => unavailable(`@clerk/electron.${String(property)}`),
  },
);

export default clerkModule;
