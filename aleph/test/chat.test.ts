import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_INTRO, ChatThreads, type ChatSdk } from '../src/chat-thread'
import { chatContract } from '../src/chat-rpc'
import { excludeChat } from '../src/chat-filter'
import { readChat, writeChat } from '../src/chat-file'

const http = (status: number) => Object.assign(new Error(`http ${status}`), { status })

function setup(opts: { saved?: { projectId: string; threadId: string | null } | null; host?: string | null; projects?: Record<string, unknown>; threads?: Record<string, unknown> } = {}) {
  let saved = opts.saved ?? null
  const calls: string[] = []
  const sdk = {
    system: { config: vi.fn(async () => ({ primaryHostId: opts.host === undefined ? 'host1' : opts.host })) },
    projects: {
      get: vi.fn(async ({ projectId }: { projectId: string }) => { calls.push(`projects.get ${projectId}`); const v = opts.projects?.[projectId]; if (v instanceof Error) throw v; if (v === undefined) throw http(404); return v }),
      create: vi.fn(async (a: unknown) => { calls.push('projects.create'); void a; return { id: 'p-new' } }),
    },
    threads: {
      get: vi.fn(async ({ threadId }: { threadId: string }) => { calls.push(`threads.get ${threadId}`); const v = opts.threads?.[threadId]; if (v instanceof Error) throw v; if (v === undefined) throw http(404); return v }),
      spawn: vi.fn(async (a: unknown) => { calls.push('threads.spawn'); void a; return { id: 't-new' } }),
    },
  }
  const mkdir = vi.fn(async () => {})
  const write = vi.fn(async (s: { projectId: string; threadId: string | null }) => { saved = s })
  const chat = new ChatThreads({ sdk: sdk as unknown as ChatSdk, workspaceDir: '/data/chat-workspace', mkdir, read: async () => saved, write })
  return { chat, sdk, mkdir, write, calls, saved: () => saved }
}

describe('ChatThreads', () => {
  it('creates the Foundry project in an empty folder, then the thread, and saves both', async () => {
    const t = setup()
    expect(await t.chat.ensure()).toEqual({ projectId: 'p-new', threadId: 't-new' })
    expect(t.mkdir).toHaveBeenCalledWith('/data/chat-workspace')
    expect(t.sdk.projects.create).toHaveBeenCalledWith({ name: 'Foundry', source: { type: 'local_path', hostId: 'host1', path: '/data/chat-workspace' } })
    expect(t.sdk.threads.spawn).toHaveBeenCalledWith({
      projectId: 'p-new', environment: { type: 'host', hostId: 'host1', workspace: { type: 'unmanaged', path: '/data/chat-workspace' } },
      title: 'Foundry', prompt: CHAT_INTRO, pluginMetadata: { chat: true }, visibility: 'visible',
    })
    expect(t.saved()).toEqual({ projectId: 'p-new', threadId: 't-new' })
  })

  it('reuses the saved project and thread without creating anything', async () => {
    const t = setup({ saved: { projectId: 'p1', threadId: 't1' }, projects: { p1: { id: 'p1' } }, threads: { t1: { id: 't1' } } })
    expect(await t.chat.ensure()).toEqual({ projectId: 'p1', threadId: 't1' })
    expect(t.sdk.projects.create).not.toHaveBeenCalled()
    expect(t.sdk.threads.spawn).not.toHaveBeenCalled()
  })

  it('makes only a new thread when the project is alive but the thread is gone', async () => {
    const t = setup({ saved: { projectId: 'p1', threadId: 't1' }, projects: { p1: { id: 'p1' } } })
    expect(await t.chat.ensure()).toEqual({ projectId: 'p1', threadId: 't-new' })
    expect(t.sdk.projects.create).not.toHaveBeenCalled()
  })

  it('treats a deleted or archived project or thread as gone', async () => {
    const t = setup({ saved: { projectId: 'p1', threadId: 't1' }, projects: { p1: { id: 'p1', archivedAt: '2026-01-01' } }, threads: { t1: { id: 't1' } } })
    expect(await t.chat.ensure()).toEqual({ projectId: 'p-new', threadId: 't-new' })
    const u = setup({ saved: { projectId: 'p1', threadId: 't1' }, projects: { p1: { id: 'p1' } }, threads: { t1: { id: 't1', deletedAt: '2026-01-01' } } })
    expect(await u.chat.ensure()).toEqual({ projectId: 'p1', threadId: 't-new' })
  })

  it('a non-404 failure is thrown and creates nothing, so a blip never makes a duplicate', async () => {
    const t = setup({ saved: { projectId: 'p1', threadId: 't1' }, projects: { p1: http(500) } })
    await expect(t.chat.ensure()).rejects.toThrow('http 500')
    expect(t.sdk.projects.create).not.toHaveBeenCalled()
    expect(t.sdk.threads.spawn).not.toHaveBeenCalled()
  })

  it('two panes asking at once share one creation; a failure is not cached', async () => {
    const t = setup()
    const [a, b] = await Promise.all([t.chat.ensure(), t.chat.ensure()])
    expect(a).toEqual(b)
    expect(t.sdk.projects.create).toHaveBeenCalledTimes(1)
    expect(t.sdk.threads.spawn).toHaveBeenCalledTimes(1)
    const f = setup({ host: null })
    await expect(f.chat.ensure()).rejects.toThrow('no primary host')
    await expect(f.chat.ensure()).rejects.toThrow('no primary host')
    expect(f.sdk.system.config).toHaveBeenCalledTimes(2)
  })

  it('keeps the new project id if the thread spawn fails, and retries only the thread', async () => {
    const t = setup()
    t.sdk.threads.spawn.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(t.chat.ensure()).rejects.toThrow('spawn failed')
    expect(t.saved()).toEqual({ projectId: 'p-new', threadId: null })
    t.sdk.projects.get.mockResolvedValue({ id: 'p-new' })
    expect(await t.chat.ensure()).toEqual({ projectId: 'p-new', threadId: 't-new' })
    expect(t.sdk.projects.create).toHaveBeenCalledTimes(1)
  })
})

describe('chat file', () => {
  it('round-trips, reports a missing file as null and rejects a bad one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foundry-chat-'))
    const path = join(dir, 'sub', 'chat.json')
    expect(await readChat(path)).toBeNull()
    await writeChat(path, { projectId: 'p', threadId: null })
    expect(await readChat(path)).toEqual({ projectId: 'p', threadId: null })
    await writeChat(path, { projectId: 'p', threadId: 't' })
    expect(await readChat(path)).toEqual({ projectId: 'p', threadId: 't' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 1, projectId: 'p', threadId: 't' })
    await writeFile(path, '{"v":2}')
    await expect(readChat(path)).rejects.toThrow('Invalid chat file')
  })
})

describe('chat contract', () => {
  const out = chatContract['chat.ensure'].output['~standard'].validate
  it('accepts non-empty ids only', () => {
    expect(out({ projectId: 'p', threadId: 't' })).toEqual({ value: { projectId: 'p', threadId: 't' } })
    for (const bad of [null, {}, { projectId: 'p' }, { projectId: '', threadId: 't' }, { projectId: 'p', threadId: 3 }]) expect(out(bad)).toHaveProperty('issues')
  })
})

describe('excludeChat', () => {
  const s = { status: 'ready', projects: [{ id: 'a' }, { id: 'chat' }], threads: [{ id: 't1', projectId: 'a' }, { id: 't2', projectId: 'chat' }] }
  it('removes the chat project and its threads, and leaves the list alone when there is no chat', () => {
    expect(excludeChat(s, 'chat')).toEqual({ status: 'ready', projects: [{ id: 'a' }], threads: [{ id: 't1', projectId: 'a' }] })
    expect(excludeChat(s, null)).toBe(s)
  })
})
