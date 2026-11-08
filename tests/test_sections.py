"""The Python read side of the sections file, against the fixture files the TypeScript backend is also checked with."""

import json
from pathlib import Path

import pytest

from foundry_core.sections import (SECTIONS_FILENAME, SectionsFileError, contract_epics, epic_ids_by_card,
                                   parse_doc, read_sections, sections_path, unsorted_cards)

FIXTURES = Path(__file__).parent / "fixtures" / "sections"
VALID = sorted((FIXTURES / "valid").glob("*.json"))
INVALID = sorted((FIXTURES / "invalid").glob("*.json"))


def test_there_are_fixtures_to_check():
    assert len(VALID) >= 2 and len(INVALID) >= 10


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_valid_fixture_parses_to_its_sections(path):
    assert parse_doc(json.loads(path.read_text())) == json.loads(path.read_text())["sections"]


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_invalid_fixture_is_rejected(path):
    with pytest.raises(SectionsFileError):
        parse_doc(json.loads(path.read_text()))


@pytest.mark.parametrize("raw", [{"v": True, "sections": []}, {"v": 1}, {"sections": []},
                                 {"v": 1, "sections": [{"id": "s_0a1b2c3d\n", "name": "A", "cardIds": []}]},
                                 {"v": 1, "sections": [{"id": "s_0a1b2c3d", "name": "x" * 81, "cardIds": []}]},
                                 {"v": 1, "sections": [{"id": "s_0a1b2c3d", "name": "a\tb", "cardIds": []}]},
                                 {"v": 1, "sections": [{"id": "s_0a1b2c3d", "name": "A", "cardIds": [1]}]}])
def test_other_malformed_documents_are_rejected(raw):
    with pytest.raises(SectionsFileError):
        parse_doc(raw)


def test_name_length_counts_utf16_units_like_the_writer():
    ok = {"v": 1, "sections": [{"id": "s_0a1b2c3d", "name": "x" * 80, "cardIds": []}]}
    assert parse_doc(ok)
    astral = {"v": 1, "sections": [{"id": "s_0a1b2c3d", "name": "\U0001F600" * 41, "cardIds": []}]}  # 82 UTF-16 units
    with pytest.raises(SectionsFileError):
        parse_doc(astral)


def test_reading_a_board_with_no_file_or_directory_gives_no_sections(tmp_path):
    assert read_sections(tmp_path) == []
    assert read_sections(tmp_path / "ghost") == []
    assert list(tmp_path.iterdir()) == []  # a read creates nothing


def test_read_sections_reads_the_file_beside_the_kanban(tmp_path):
    (tmp_path / "kanban.db").write_bytes(b"db")
    (tmp_path / SECTIONS_FILENAME).write_text(VALID[-1].read_text())
    assert sections_path(tmp_path) == tmp_path / "foundry-sections.json"
    got = read_sections(tmp_path)
    assert [s["name"] for s in got] == ["Docs", "Release prep"]
    assert (tmp_path / "kanban.db").read_bytes() == b"db"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["foundry-sections.json", "kanban.db"]


@pytest.mark.parametrize("text", ["{nope", "", '{"v":2,"sections":[]}'])
def test_a_corrupt_file_raises_and_is_left_alone(tmp_path, text):
    f = tmp_path / SECTIONS_FILENAME
    f.write_text(text)
    with pytest.raises(SectionsFileError):
        read_sections(tmp_path)
    assert f.read_text() == text


SECTIONS = [{"id": "s_0a1b2c3d", "name": "Docs", "cardIds": ["atlas:t_2"]},
            {"id": "s_4e5f6a7b", "name": "Ship", "cardIds": ["atlas:t_9", "atlas:t_1"]}]


def test_unsorted_is_computed_from_the_card_list_in_its_order():
    assert unsorted_cards(SECTIONS, ["atlas:t_3", "atlas:t_2", "atlas:t_1", "atlas:t_0"]) == ["atlas:t_3", "atlas:t_0"]
    assert unsorted_cards([], ["a"]) == ["a"]
    assert unsorted_cards(SECTIONS, []) == []


def test_sections_map_to_the_contracts_epics():
    assert contract_epics("atlas", SECTIONS) == [{"id": "atlas:s_0a1b2c3d", "title": "Docs"},
                                                  {"id": "atlas:s_4e5f6a7b", "title": "Ship"}]
    assert epic_ids_by_card("atlas", SECTIONS) == {"atlas:t_2": "atlas:s_0a1b2c3d", "atlas:t_9": "atlas:s_4e5f6a7b",
                                                    "atlas:t_1": "atlas:s_4e5f6a7b"}


@pytest.mark.parametrize("board", ["../x", "Atlas", "", "a:b", "atlas\n"])
def test_a_board_name_that_is_not_a_slug_is_refused(board):
    with pytest.raises(ValueError):
        contract_epics(board, SECTIONS)
    with pytest.raises(ValueError):
        epic_ids_by_card(board, SECTIONS)
