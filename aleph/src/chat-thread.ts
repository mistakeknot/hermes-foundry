// The one Foundry workspace thread (mk-ps6ow.14.11). It lives in a bb project named "Foundry" that points at an empty
// folder under the plugin's data directory. Server-side only: find the project and thread made before, or make them.
// A lost write, a lost reply or a crash must not make a second one, so before creating anything it looks for what an
// earlier attempt left behind (a project named Foundry on this folder, a live thread titled Foundry in it). Structural
// SDK types, so tests need no bb.

export interface ChatSdk {
  system: { config(): Promise<{ primaryHostId: string | null }> }
  projects: {
    get(args: { projectId: string }): Promise<unknown>
    list(args?: Record<string, unknown>): Promise<unknown[]>
    create(args: { name: string; source: { type: 'local_path'; hostId: string; path: string } }): Promise<{ id: string }>
  }
  threads: {
    get(args: { threadId: string }): Promise<unknown>
    list(args: { projectId: string; limit?: number; offset?: number }): Promise<unknown[]>
    spawn(args: Record<string, unknown>): Promise<{ id: string }>
  }
}

export interface ChatIds { projectId: string; threadId: string }
export interface Saved { projectId: string; threadId: string | null }

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
  'This folder is empty on purpose. Reply with one short line saying you are ready, then wait for the user.',
].join('\n')

const LIST_PAGE = 100
const LIST_PAGE_CAP = 100 // 10,000 threads in one project; beyond that the search is incomplete and no thread is made
const isMissing = (e: unknown) => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404
const isGone = (v: unknown) => typeof v === 'object' && v !== null && ((v as { deletedAt?: unknown }).deletedAt != null || (v as { archivedAt?: unknown }).archivedAt != null)
const field = (v: unknown, k: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined)

/** False when the thing is missing, deleted or archived; any other failure is thrown so a blip never makes a second one. */
async function alive(get: () => Promise<unknown>): Promise<boolean> {
  try { return !isGone(await get()) } catch (e) { if (isMissing(e)) return false; throw e }
}

export class ChatThreads {
  private pending: Promise<ChatIds> | null = null
  constructor(private readonly deps: ChatDeps) {}

  /** Single-flight within this process: two panes asking at once get the same project and thread. A failure is not cached. */
  ensure(): Promise<ChatIds> {
    this.pending ??= this.run().finally(() => { this.pending = null })
    return this.pending
  }

  /**
   * The chat project's id, never creating anything: the saved one if it is still alive, else the one an earlier attempt
   * left on the workspace folder, else null. The panel uses it to keep the chat out of the valley even while the thread
   * is still being made or could not be made.
   */
  async project(): Promise<string | null> {
    const saved = await this.deps.read()
    if (saved?.projectId && await alive(() => this.deps.sdk.projects.get({ projectId: saved.projectId }))) return saved.projectId
    return this.findProject()
  }

  /** A live project named Foundry that has the workspace folder as a source. The oldest, so every attempt agrees. */
  private async findProject(): Promise<string | null> {
    const rows = await this.deps.sdk.projects.list({ includePersonal: false })
    const mine = rows
      .filter(p => !isGone(p) && field(p, 'name') === CHAT_PROJECT_NAME && typeof field(p, 'id') === 'string'
        && Array.isArray(field(p, 'sources')) && (field(p, 'sources') as unknown[]).some(s => field(s, 'path') === this.deps.workspaceDir))
      .sort((a, b) => Number(field(a, 'createdAt') ?? 0) - Number(field(b, 'createdAt') ?? 0))
    return mine.length ? field(mine[0], 'id') as string : null
  }

  /** A live thread titled Foundry in the chat project. The oldest, so every attempt agrees. */
  private async findThread(projectId: string): Promise<string | null> {
    const rows = await this.listThreads(projectId)
    const mine = rows
      .filter(t => !isGone(t) && typeof field(t, 'id') === 'string' && (field(t, 'displayTitle') ?? field(t, 'title')) === CHAT_THREAD_TITLE)
      .sort((a, b) => Number(field(a, 'createdAt') ?? 0) - Number(field(b, 'createdAt') ?? 0))
    return mine.length ? field(mine[0], 'id') as string : null
  }

  /** Every thread of the project, a page at a time until a page comes back empty, so an old orphan is never missed behind newer threads. */
  private async listThreads(projectId: string): Promise<unknown[]> {
    const all: unknown[] = []
    for (let page = 0; page < LIST_PAGE_CAP; page++) {
      const rows = await this.deps.sdk.threads.list({ projectId, limit: LIST_PAGE, offset: all.length })
      if (!rows.length) return all
      all.push(...rows)
    }
    // Not seeing every thread means an orphan could be hidden, so making another could duplicate it.
    throw new Error('the Foundry project has too many threads to search for an earlier Foundry thread')
  }

  private async primaryHost(): Promise<string> {
    const hostId = (await this.deps.sdk.system.config()).primaryHostId
    if (!hostId) throw new Error('bb has no primary host to keep the Foundry workspace on')
    return hostId
  }

  private async run(): Promise<ChatIds> {
    const { sdk, workspaceDir } = this.deps
    const saved = await this.deps.read()
    let projectId = saved?.projectId ?? null
    if (projectId && !(await alive(() => sdk.projects.get({ projectId: projectId! })))) projectId = null
    projectId ??= await this.findProject()
    if (!projectId) {
      const hostId = await this.primaryHost()
      await this.deps.mkdir(workspaceDir)
      projectId = (await sdk.projects.create({ name: CHAT_PROJECT_NAME, source: { type: 'local_path', hostId, path: workspaceDir } })).id
    }
    // Saved at once. If this write fails, the next attempt finds the project by name and folder instead of making another.
    if (projectId !== saved?.projectId) await this.deps.write({ projectId, threadId: null })
    let threadId = projectId === saved?.projectId ? saved?.threadId ?? null : null
    if (threadId && !(await alive(() => sdk.threads.get({ threadId: threadId! })))) threadId = null
    threadId ??= await this.findThread(projectId)
    if (!threadId) {
      const hostId = await this.primaryHost()
      threadId = (await sdk.threads.spawn({
        projectId,
        environment: { type: 'host', hostId, workspace: { type: 'unmanaged', path: workspaceDir } },
        title: CHAT_THREAD_TITLE,
        prompt: CHAT_INTRO,
        pluginMetadata: { chat: true },
        visibility: 'visible',
      })).id
    }
    if (threadId !== saved?.threadId || projectId !== saved?.projectId) await this.deps.write({ projectId, threadId })
    return { projectId, threadId }
  }
}
