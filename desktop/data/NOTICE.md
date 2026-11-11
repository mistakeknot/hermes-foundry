# Jawnomicon credit

The creature names, motif identifiers and eidogen dimensions in
`jawnomicon-v50.json` are a small, credited slice of **Jawnomicon**
(https://jawnomicon.com), used with permission for Foundry. Credit to the
Jawnomicon project and its contributors. The source export is **v50**.

Source file: `exports/v50/bestiary.json`

SHA256: `dca94ff2d1e4a02468a5f349d81d421d1e22ad81bca298c59c22384c3ec6abb4`

This slice contains 48 folklore creatures and 155 distinct motif identifiers.
Only `id`, `name`, `motifs` (identifiers of HAS_MOTIF targets), and the 29
`eidogen.dimensions` values are copied. No prose descriptions, evidence,
justifications, other relations or unpublished export data are included.
Permission covers this subset; it makes no claim to license the full source
export under Foundry's MIT license.

Selection is a design choice: a curated folklore-name allowlist, then greedy
coverage of previously unrepresented motif identifiers, with identifier ties.
The reproducible selector is `tests/fixtures/select_lineages.py`; run it with
the v50 bestiary file and an output path as its two arguments. No source
repository is needed to build or run Foundry.
