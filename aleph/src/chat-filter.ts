// The chat's own project and thread stay out of the valley (GSVP-49): the board shows the user's work, not the workspace
// the assistant sits in. Structural, like from-sidebar.ts.
export function excludeChat<S extends { projects: readonly { id: string }[]; threads: readonly { projectId: string }[] }>(s: S, chatProjectId: string | null): S {
  if (!chatProjectId) return s
  return { ...s, projects: s.projects.filter(p => p.id !== chatProjectId), threads: s.threads.filter(t => t.projectId !== chatProjectId) }
}
