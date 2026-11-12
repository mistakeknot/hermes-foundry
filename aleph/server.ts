// Creature preferences belong to this Aleph plugin; section writes go through the host's sections backend.
// Agent edits are relayed to the open Foundry pane, which owns the dispatcher (see src/edit-bridge.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { operations } from './src/edit-operations';
import { EditBridge, toolText } from './src/edit-bridge';
import { editContract } from './src/edit-bridge-rpc';
import { FileLineageStore } from './src/lineage/file-store';
import { lineageContract } from './src/lineage/rpc';
import { ChatThreads } from './src/chat-thread';
import { chatContract } from './src/chat-rpc';
import { readChat, writeChat } from './src/chat-file';

const toolName = (op: string) => `foundry_${op}`;

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const store = new FileLineageStore(join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'lineages.json'));
  bb.rpc.register(lineageContract, {
    'lineage.get': ({ projectId }) => store.get(projectId),
    'lineage.set': ({ projectId, patch }) => store.set(projectId, patch),
  });

  // The one workspace thread. It is made on first ask, after this plugin's tools exist, so it starts with them.
  const pluginDir = join(bb.server.experimental_dataDir, 'plugins', bb.pluginId);
  const chatPath = join(pluginDir, 'chat.json');
  const chat = new ChatThreads({
    sdk: bb.sdk as never,
    workspaceDir: join(pluginDir, 'chat-workspace'),
    mkdir: async dir => { await mkdir(dir, { recursive: true }); },
    read: () => readChat(chatPath),
    write: saved => writeChat(chatPath, saved),
  });
  bb.rpc.register(chatContract, {
    'chat.ensure': () => chat.ensure(),
    'chat.project': async () => ({ projectId: await chat.project() }),
  });

  const bridge = new EditBridge((channel, payload) => bb.realtime.publish(channel, payload));
  bb.rpc.register(editContract, {
    'edit.claim': ({ callId, paneId }) => bridge.claim(callId, paneId),
    'edit.report': ({ callId, paneId, result }) => bridge.report(callId, paneId, result),
  });
  for (const op of operations) {
    bb.agents.registerTool({
      name: toolName(op.name),
      description: op.description,
      parameters: op.parameters as unknown as Record<string, unknown>,
      async execute(params, ctx) {
        const { text, isError } = toolText(await bridge.call({ name: op.name, arguments: (params ?? {}) as Record<string, unknown> }, ctx.signal), op.name);
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
