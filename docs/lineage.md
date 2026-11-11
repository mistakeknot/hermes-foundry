# Creature lineage

`buildCreature(project)` now assigns a seeded Jawnomicon lineage from the
bundled v50 slice. The project name stays the display name; `spec.lineage`
supplies `{ id, name }` for an inspector's “This project is a …” label.
No network lookup is needed. Data credits and source checksum are in
`desktop/data/NOTICE.md`.

The generator accepts a `CreatureProject` (the existing `Project` plus an
optional `lineage` selection):

```ts
buildCreature(project) // stable seeded default
buildCreature({ ...project, lineage: { reroll: 1 } })
buildCreature({ ...project, lineage: { name: 'Phoenix' } })
buildCreature({ ...project, lineage: { name: '1_phoenix' } })
buildCreature({ ...project, lineage: null }) // legacy generator
```

Names match without case or surrounding whitespace; ids are also accepted.
An unknown explicit name falls back to the legacy generator. Re-roll is a
safe integer counter; consecutive values visit every lineage before wrapping.
`pickLineage(id, selection, catalogue)` also accepts an empty catalogue and
returns undefined when no lineage is available. Invalid counters use zero.
Selection sorts by id, so input catalogue order cannot change a project's pick.

Design choice: motif families (winged, serpentine, solid, horned/many-headed)
deform the abstract torso, crown lumps and section paths. The whole eidogen
vector contributes to fullness; named dimensions control height, reach and
sway. Empathy, nurturing and emotional processing select among the renderer's
existing stone, lichen and coral colours. Non-applicable dimensions are neutral.
These are abstract variations, rather than anatomical portraits of the names.
Sections still own limbs and threads still own scales; status only changes
counts/scale colour, never their geometry.

This bead supplies the generator API. Inspector controls and persistence of
the name/re-roll selection belong to the inspector integration. The scene's
creature cache key must also include that selection when wiring live edits.
The committed Hermes bundle is preserved; Aleph imports the shared source directly.
Rebuild the Hermes bundle in a subsequent authorized bundle update.
