"""Tests für die CLI."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PYTHONPATH = str(REPO_ROOT / "src")


def run_cli(db: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pp.cli", "--db", str(db), *args],
        capture_output=True,
        text=True,
        env={"PYTHONPATH": PYTHONPATH, "PATH": "/usr/bin:/bin"},
    )


class CliTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "db.json"
        result = run_cli(self.db, "project", "add", "p1", "Projekt 1")
        self.assertEqual(result.returncode, 0, result.stderr)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_item_add_and_board(self) -> None:
        result = run_cli(self.db, "item", "add", "p1", "i1", "Erster Eintrag")
        self.assertEqual(result.returncode, 0, result.stderr)
        board = run_cli(self.db, "board", "p1")
        self.assertIn("Erster Eintrag", board.stdout)

    def test_move(self) -> None:
        run_cli(self.db, "item", "add", "p1", "i1", "Eintrag")
        result = run_cli(self.db, "item", "move", "p1", "i1", "fertig")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("fertig", result.stdout)

    def test_move_unknown_item_fails(self) -> None:
        result = run_cli(self.db, "item", "move", "p1", "nx", "fertig")
        self.assertNotEqual(result.returncode, 0)

    def test_item_list_filter_status(self) -> None:
        run_cli(self.db, "item", "add", "p1", "i1", "A")
        run_cli(self.db, "item", "add", "p1", "i2", "B")
        run_cli(self.db, "item", "move", "p1", "i2", "fertig")
        result = run_cli(self.db, "item", "list", "p1", "--status", "fertig")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("B", result.stdout)
        self.assertNotIn("A", result.stdout)

    def test_item_list_filter_priority(self) -> None:
        run_cli(self.db, "item", "add", "p1", "i1", "A", "--priority", "hoch")
        run_cli(self.db, "item", "add", "p1", "i2", "B")
        result = run_cli(self.db, "item", "list", "p1", "--priority", "hoch")
        self.assertIn("A", result.stdout)
        self.assertNotIn("B", result.stdout)


if __name__ == "__main__":
    unittest.main()
