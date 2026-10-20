"""Tests für den GitLab-Sync (mit Fake-Client, ohne Netzwerk)."""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pp.gitlab_sync import GitLabClient, GitLabError, sync_project
from pp.model import Item, Project


class FakeClient(GitLabClient):
    def __init__(self) -> None:
        super().__init__("https://gitlab.example", "token", "agil")
        self.repos: list[str] = []
        self.issues: dict[str, list[dict]] = {}
        self.group_checked = 0

    def ensure_group(self) -> None:
        self.group_checked += 1

    def ensure_repo(self, project: Project) -> dict:
        repo = f"{self.group}/{project.id}"
        if repo not in self.repos:
            self.repos.append(repo)
            self.issues[repo] = []
        return {"path_with_namespace": repo}

    def list_issues(self, project: Project) -> list[dict]:
        return self.issues[f"{self.group}/{project.id}"]

    def ensure_issue(self, project, item_id, title, priority, status) -> dict:
        repo = f"{self.group}/{project.id}"
        for issue in self.issues[repo]:
            if issue["title"] == f"[{item_id}] {title}":
                issue["state"] = "closed" if status == "fertig" else "opened"
                issue["labels"] = [f"status:{status}", f"prio:{priority}"]
                return issue
        issue = {
            "title": f"[{item_id}] {title}",
            "state": "closed" if status == "fertig" else "opened",
            "labels": [f"status:{status}", f"prio:{priority}"],
        }
        self.issues[repo].append(issue)
        return issue

    def close_issue(self, project: Project, item_id: str) -> None:
        repo = f"{self.group}/{project.id}"
        for issue in self.issues[repo]:
            if issue["title"].startswith(f"[{item_id}] "):
                issue["state"] = "closed"
                return


class SyncTest(unittest.TestCase):
    def test_sync_creates_repo_and_issues(self) -> None:
        client = FakeClient()
        project = Project(id="p1", name="Projekt 1")
        project.add_item(Item(id="i1", project_id="p1", title="A", priority="hoch"))
        project.add_item(Item(id="i2", project_id="p1", title="B"))

        result = sync_project(client, project)

        self.assertEqual(result["repo"], "agil/p1")
        self.assertEqual(result["created"], 2)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(len(client.issues["agil/p1"]), 2)
        self.assertTrue(any("status:offen" in i["labels"] for i in client.issues["agil/p1"]))

    def test_sync_is_idempotent(self) -> None:
        client = FakeClient()
        project = Project(id="p1", name="Projekt 1")
        project.add_item(Item(id="i1", project_id="p1", title="A"))

        first = sync_project(client, project)
        second = sync_project(client, project)

        self.assertEqual(first["created"], 1)
        self.assertEqual(second["created"], 0)
        self.assertEqual(second["updated"], 1)
        self.assertEqual(len(client.issues["agil/p1"]), 1)

    def test_sync_reflects_status_and_priority(self) -> None:
        client = FakeClient()
        project = Project(id="p1", name="Projekt 1")
        project.add_item(Item(id="i1", project_id="p1", title="A", priority="mittel"))
        sync_project(client, project)

        project.move_item("i1", "fertig")
        sync_project(client, project)

        issue = client.issues["agil/p1"][0]
        self.assertEqual(issue["state"], "closed")
        self.assertIn("status:fertig", issue["labels"])


class EnvTest(unittest.TestCase):
    def test_missing_env_fails(self) -> None:
        import os
        saved = (os.environ.pop("GITLAB_TOKEN", None), os.environ.pop("GITLAB_GROUP", None))
        try:
            with self.assertRaises(GitLabError):
                from pp.gitlab_sync import client_from_env
                client_from_env()
        finally:
            if saved[0]: os.environ["GITLAB_TOKEN"] = saved[0]
            if saved[1]: os.environ["GITLAB_GROUP"] = saved[1]


if __name__ == "__main__":
    unittest.main()
