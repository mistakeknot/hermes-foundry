// The saved ids of the Foundry chat project and thread: one small plugin-owned JSON file, replaced atomically.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface SavedChat { projectId: string; threadId: string | null }

export async function readChat(path: string): Promise<SavedChat | null> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  const doc = JSON.parse(text)
  if (doc?.v !== 1 || typeof doc.projectId !== 'string' || !doc.projectId || !(doc.threadId === null || typeof doc.threadId === 'string')) throw new Error('Invalid chat file')
  return { projectId: doc.projectId, threadId: doc.threadId }
}

export async function writeChat(path: string, saved: SavedChat): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify({ v: 1, ...saved }), 'utf8')
  await rename(temp, path)
}
