"""Reproduce the approved v50 slice: python select_lineages.py SOURCE OUTPUT.

Design choice: a folklore-name allowlist, then greedy motif coverage (id ties).
Only the four approved fields leave the source export.
"""
import json
import sys

NAMES = """Anansi|Basilisk|Bigfoot|Bunyip|Cerberus|Chimera|Chupacabra|Griffin|Jackalope|Kelpie|Kitsune|Kraken|Loch Ness Monster|Manticore|Minotaur|Mothman|Pegasus|Phoenix|Qilin|Roc|Sphinx|Thunderbird|Tiamat|Unicorn|Valkyrie|Yeti|Baba Yaga|Baku|Banshee|Behemoth|Black Dog|Bogeyman|Cockatrice|Cyclops|Dullahan|Fenrir|Gargoyle|Goblin|Hippogriff|Hydra|Leviathan|Mermaid|Naga|Ogre|Oni|Orc|Sasquatch|Sleipnir|Troll|Vampire|Werewolf|Anubis|Dokkaebi|Domovoi|Draugr|Garuda|Golem|Jiangshi|Kappa|Krampus|Leprechaun|Medusa|Nisse|Pazuzu|Rakshasa|Rusalka|Salamander|Selkie|Wyvern|Yuki-onna|Jorōgumo|Lamia|Rainbow Serpent|Redcap|Brownie|Changeling|Furies|Elves|Nymphs|Dwarf|Fates""".split('|')


def select(source):
    candidates = [
        {"id": c["id"], "name": c["name"],
         "motifs": sorted({r["target"] for r in c.get("relations", []) if r["type"] == "HAS_MOTIF"}),
         "eidogen": c["eidogen"]["dimensions"]}
        for c in source["creatures"] if c["name"] in NAMES
        and len(c.get("eidogen", {}).get("dimensions", {})) == 29
        and any(r["type"] == "HAS_MOTIF" for r in c.get("relations", []))
    ]
    chosen, covered = [], set()
    while len(chosen) < 48:
        c = min(candidates, key=lambda c: (-len(set(c["motifs"]) - covered), c["id"]))
        chosen.append(c)
        covered.update(c["motifs"])
        candidates.remove(c)
    return sorted(chosen, key=lambda c: c["id"])


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as src:
        result = select(json.load(src))
    with open(sys.argv[2], 'w', encoding='utf-8') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
        out.write('\n')
