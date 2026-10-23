"""Tests für Datenmodell und Speicher."""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pp.model import Item, Project
from pp.store import Store


class ModelTest(unittest.TestCase):
    def test_add_and_find_item(self) -> None:
        project = Project(id="p1", name="Projekt 1")
        item = Item(id="i1", project_id="p1", title="Erster Eintrag")
        project.add_item(item)
        self.assertEqual(project.find_item("i1"), item)
        self.assertEqual(item.project_id, "p1")

    def test_duplicate_item_fails(self) -> None:
        project = Project(id="p1", name="Projekt 1")
        project.add_item(Item(id="i1", project_id="p1", title="A"))
        with self.assertRaises(ValueError):
            project.add_item(Item(id="i1", project_id="p1", title="B"))

    def test_move_item(self) -> None:
        project = Project(id="p1", name="P")
        project.add_item(Item(id="i1", project_id="p1", title="A"))
        moved = project.move_item("i1", "in_arbeit")
        self.assertEqual(moved.status, "in_arbeit")

    def test_invalid_status_fails(self) -> None:
        project = Project(id="p1", name="P")
        project.add_item(Item(id="i1", project_id="p1", title="A"))
        with self.assertRaises(ValueError):
            project.move_item("i1", " kaputt ")

    def test_roundtrip(self) -> None:
        project = Project(id="p1", name="P", description="d")
        project.add_item(Item(id="i1", project_id="p1", title="A", priority="hoch"))
        restored = Project.from_dict(project.to_dict())
        self.assertEqual(restored.items[0].title, "A")
        self.assertEqual(restored.items[0].priority, "hoch")


class StoreTest(unittest.TestCase):
    def test_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "db.json"
            store = Store(db)
            store.add_project(Project(id="p1", name="P"))
            store.get_project("p1").add_item(
                Item(id="i1", project_id="p1", title="A")
            )
            store.save()

            reloaded = Store(db)
            project = reloaded.get_project("p1")
            self.assertIsNotNone(project)
            self.assertEqual(project.items[0].title, "A")

    def test_duplicate_project_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "db.json")
            store.add_project(Project(id="p1", name="P"))
            with self.assertRaises(ValueError):
                store.add_project(Project(id="p1", name="P2"))


if __name__ == "__main__":
    unittest.main()
