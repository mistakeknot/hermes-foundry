import { LiveApi } from '../../desktop/src/live'
import type { InspectorEdits } from './inspector-edits'

/** A committed edit invalidates the scene's epoch; its next poll obtains the same state the form shows. */
export class InspectorLiveApi extends LiveApi {
  constructor(private edits: InspectorEdits) { super() }
  override get epoch() { return `${super.epoch}-edits-${this.edits.version()}` }
  override async snapshot() {
    const snapshot = await super.snapshot()
    return { ...snapshot, projects: snapshot.projects.map(p => ({ ...p, lineage: this.edits.project(p.id).creature.lineage })) }
  }
}
