// Creature preferences belong to this Aleph plugin; section writes go through the host's sections backend.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from 'node:path';
import { FileLineageStore } from './src/lineage/file-store';
import { lineageContract } from './src/lineage/rpc';

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const store = new FileLineageStore(join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'lineages.json'));
  bb.rpc.register(lineageContract, {
    'lineage.get': ({ projectId }) => store.get(projectId),
    'lineage.set': ({ projectId, patch }) => store.set(projectId, patch),
  });
}
