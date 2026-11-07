import type { LiveInput, LiveThread } from '../../desktop/src/live'

// The parts of the bb sidebar state Foundry reads (structural, so tests need no SDK).
export interface SidebarThreadLike {
  id: string; projectId: string; displayTitle: string; sectionId: string | null; providerId: string
  status: string; hasPendingInteraction: boolean; isUnread: boolean; isArchived: boolean; isHidden: boolean; updatedAt: number
}
export interface SidebarStateLike {
  threads: readonly SidebarThreadLike[]
  projects: readonly { id: string; name: string }[]
  sections: readonly { id: string; name: string }[]
}

export function fromSidebar(s: SidebarStateLike, now: number): LiveInput {
  return {
    now,
    projects: s.projects.map((p) => ({ id: p.id, name: p.name })),
    sections: s.sections.map((x) => ({ id: x.id, name: x.name })),
    threads: s.threads.map((t): LiveThread => ({
      id: t.id, projectId: t.projectId, title: t.displayTitle, sectionId: t.sectionId, provider: t.providerId, status: t.status,
      needsHuman: t.hasPendingInteraction, unread: t.isUnread, archived: t.isArchived, hidden: t.isHidden, updatedAt: t.updatedAt,
    })),
  }
}
