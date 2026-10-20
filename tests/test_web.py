"""Tests für die Web-API des Boardservers."""

import json
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PYTHONPATH = str(REPO_ROOT / "src")
PORT = 8177
BASE = f"http://127.0.0.1:{PORT}"


def request(path: str, payload: dict | None = None) -> tuple[int, object]:
    if payload is None:
        req = urllib.request.Request(BASE + path)
    else:
        req = urllib.request.Request(
            BASE + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode())


class WebApiTest(unittest.TestCase):
    server: subprocess.Popen

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls._tmp.name) / "db.json"
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "pp.cli", "--db", str(cls.db), "serve", "--port", str(PORT)],
            env={"PYTHONPATH": PYTHONPATH, "PATH": "/usr/bin:/bin"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + "/api/projects", timeout=1)
                return
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.terminate()
        cls.server.wait()
        cls._tmp.cleanup()

    def test_01_index_and_meta(self) -> None:
        with urllib.request.urlopen(BASE + "/") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("text/html", response.headers["Content-Type"])

    def test_02_create_project(self) -> None:
        status, project = request("/api/projects", {"id": "p1", "name": "Web", "description": "d"})
        self.assertEqual(status, 201)
        self.assertEqual(project["name"], "Web")

    def test_03_duplicate_project_fails(self) -> None:
        status, data = request("/api/projects", {"id": "p1", "name": "Web2"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_04_add_item(self) -> None:
        status, item = request("/api/items", {"project_id": "p1", "id": "i1", "title": "A", "priority": "hoch"})
        self.assertEqual(status, 201)
        self.assertEqual(item["priority"], "hoch")

    def test_05_add_item_unknown_project(self) -> None:
        status, data = request("/api/items", {"project_id": "nx", "id": "i2", "title": "B"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_06_move_item(self) -> None:
        status, item = request("/api/move", {"project_id": "p1", "item_id": "i1", "status": "fertig"})
        self.assertEqual(status, 200)
        self.assertEqual(item["status"], "fertig")

    def test_07_move_invalid_status(self) -> None:
        status, data = request("/api/move", {"project_id": "p1", "item_id": "i1", "status": "keks"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_08_delete_item(self) -> None:
        status, data = request("/api/delete", {"project_id": "p1", "item_id": "i1"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"deleted": "i1"})

    def test_09_delete_twice_fails(self) -> None:
        status, data = request("/api/delete", {"project_id": "p1", "item_id": "i1"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_10_persistence(self) -> None:
        status, projects = request("/api/projects")
        self.assertEqual(status, 200)
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["items"], [])


if __name__ == "__main__":
    unittest.main()
