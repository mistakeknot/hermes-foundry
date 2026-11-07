// Foundry reads the sidebar thread list in the browser, so the server side has nothing to do yet.
// A server entry is kept so the manifest matches the scaffold; commands (acting on threads) would be added here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(_bb: BbPluginApi): Promise<void> {}
