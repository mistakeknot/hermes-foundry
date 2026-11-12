// Creature preferences belong to this Aleph plugin; section writes go through the host's sections backend.
// Agent edits are relayed to the open Foundry pane, which owns the dispatcher (see src/edit-bridge.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from 'node:path';
import { operations } from './src/edit-operations';
import { EditBridge, toolText } from './src/edit-bridge';
import { editContract } from './src/edit-bridge-rpc';
import { FileLineageStore } from './src/lineage/file-store';
import { lineageContract } from './src/lineage/rpc';

const toolName = (op: string) => `foundry_${op}`;

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const store = new FileLineageStore(join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'lineages.json'));
  bb.rpc.register(lineageContract, {
    'lineage.get': ({ projectId }) => store.get(projectId),
    'lineage.set': ({ projectId, patch }) => store.set(projectId, patch),
  });

  const bridge = new EditBridge((channel, payload) => bb.realtime.publish(channel, payload));
  bb.rpc.register(editContract, {
    'edit.claim': ({ callId }) => bridge.claim(callId),
    'edit.report': ({ callId, result }) => bridge.report(callId, result),
  });
  for (const op of operations) {
    bb.agents.registerTool({
      name: toolName(op.name),
      description: op.description,
      parameters: op.parameters as unknown as Record<string, unknown>,
      async execute(params, ctx) {
        const { text, isError } = toolText(await bridge.call({ name: op.name, arguments: params }, ctx.signal));
        return { content: [{ type: 'text', text }], isError };
      },
    });
  }
  // Only a thread marked as the Foundry chat gets the edit tools.
  bb.agents.configure(ctx => ({
    tools: ctx.pluginMetadata.chat === true ? operations.map(op => toolName(op.name)) : [],
    skills: [],
  }));
}
