// The one Foundry workspace thread (mk-ps6ow.14.11). It lives in a bb project named "Foundry" that points at an empty
// folder under the plugin's data directory, so the chat has no repo to read or damage. Server-side only: find the
// project and thread it made before, or make them once. Structural SDK types, so tests need no bb.

export interface ChatSdk {
  system: { config(): Promise<{ primaryHostId: string | null }> }
  projects: {
    get(args: { projectId: string }): Promise<unknown>
    create(args: { name: string; source: { type: 'local_path'; hostId: string; path: string } }): Promise<{ id: string }>
  }
  threads: {
    get(args: { threadId: string }): Promise<unknown>
    spawn(args: Record<string, unknown>): Promise<{ id: string }>
  }
}

export interface ChatIds { projectId: string; threadId: string }
interface Saved { projectId: string; threadId: string | null }

export interface ChatDeps {
  sdk: ChatSdk
  /** The empty folder the project points at. Created when missing. */
  workspaceDir: string
  mkdir(dir: string): Promise<void>
  read(): Promise<Saved | null>
  write(saved: Saved): Promise<void>
}

export const CHAT_PROJECT_NAME = 'Foundry'
export const CHAT_THREAD_TITLE = 'Foundry'
// The chat thread's first turn. It must not edit anything; it only tells the model what it is for.
export const CHAT_INTRO = [
  'You are the Foundry assistant. Foundry shows the user\'s bb projects as creatures, their sections as limbs and their threads as cards.',
  'You have foundry_* tools to rename a section, move a thread, pick or re-roll a creature\'s look, and undo an edit. Small edits apply at once and the reply gives an edit id for undo.',
  'This folder is empty on purpose: there are no files to read or change. Reply with one short line saying you are ready, then wait for the user.',
].join('\n')

const isMissing = (e: unknown) => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404
const isGone = (v: unknown) => typeof v === 'object' && v !== null && ((v as { deletedAt?: unknown }).deletedAt != null || (v as { archivedAt?: unknown }).archivedAt != null)

/** False when the thing is missing, deleted or archived; any other failure is thrown so a blip never makes a second one. */
async function alive(get: () => Promise<unknown>): Promise<boolean> {
  try { return !isGone(await get()) } catch (e) { if (isMissing(e)) return false; throw e }
}

export class ChatThreads {
  private pending: Promise<ChatIds> | null = null
  constructor(private readonly deps: ChatDeps) {}

  /** Single-flight: two panes asking at once get the same project and thread. A failure is not cached. */
  ensure(): Promise<ChatIds> {
    this.pending ??= this.run().finally(() => { this.pending = null })
    return this.pending
  }

  private async run(): Promise<ChatIds> {
    const { sdk, workspaceDir } = this.deps
    const saved = await this.deps.read()
    let projectId = saved?.projectId ?? null
    if (projectId && !(await alive(() => sdk.projects.get({ projectId: projectId! })))) projectId = null
    if (!projectId) {
      const hostId = (await sdk.system.config()).primaryHostId
      if (!hostId) throw new Error('bb has no primary host to keep the Foundry workspace on')
      await this.deps.mkdir(workspaceDir)
      projectId = (await sdk.projects.create({ name: CHAT_PROJECT_NAME, source: { type: 'local_path', hostId, path: workspaceDir } })).id
      await this.deps.write({ projectId, threadId: null })
    }
    let threadId = projectId === saved?.projectId ? saved?.threadId ?? null : null
    if (threadId && !(await alive(() => sdk.threads.get({ threadId: threadId! })))) threadId = null
    if (!threadId) {
      const hostId = (await sdk.system.config()).primaryHostId
      if (!hostId) throw new Error('bb has no primary host to keep the Foundry workspace on')
      threadId = (await sdk.threads.spawn({
        projectId,
        environment: { type: 'host', hostId, workspace: { type: 'unmanaged', path: workspaceDir } },
        title: CHAT_THREAD_TITLE,
        prompt: CHAT_INTRO,
        pluginMetadata: { chat: true },
        visibility: 'visible',
      })).id
      await this.deps.write({ projectId, threadId })
    }
    return { projectId, threadId }
  }
}
