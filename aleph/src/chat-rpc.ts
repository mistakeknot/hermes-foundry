// RPC the panel uses to learn which project and thread are the Foundry chat. Standard Schema, no validation dependency.
import type { ChatIds } from './chat-thread'

const isIds = (raw: unknown): raw is ChatIds => {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return typeof r.projectId === 'string' && r.projectId.length > 0 && typeof r.threadId === 'string' && r.threadId.length > 0
}
export const chatContract = {
  'chat.ensure': {
    input: { '~standard': { types: undefined as { input: unknown; output: Record<string, never> } | undefined, version: 1 as const, vendor: 'foundry', validate: (raw: unknown) => ({ value: (raw ?? {}) as Record<string, never> }) } },
    output: { '~standard': { types: undefined as { input: unknown; output: ChatIds } | undefined, version: 1 as const, vendor: 'foundry', validate: (raw: unknown) =>
      isIds(raw) ? { value: { projectId: raw.projectId, threadId: raw.threadId } } : { issues: [{ message: 'Invalid chat ids' }] } } },
  },
}
