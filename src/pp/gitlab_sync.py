"""Sync zwischen pp-Projekten und GitLab (Repo je Projekt, Issue je Eintrag)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .model import Project

ISSUE_STATE = {
    "offen": "opened",
    "in_arbeit": "opened",
    "pruefung": "opened",
    "fertig": "closed",
}
ISSUE_LABELS = {
    "offen": "status:offen",
    "in_arbeit": "status:in_arbeit",
    "pruefung": "status:pruefung",
    "fertig": "status:fertig",
}
PRIORITY_PREFIX = "prio:"


class GitLabError(RuntimeError):
    pass


class GitLabClient:
    """Minimaler GitLab-REST-Client (v4) auf Basis der Standardbibliothek."""

    def __init__(self, url: str, token: str, group: str) -> None:
        self.base = url.rstrip("/") + "/api/v4"
        self.token = token
        self.group = group

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "PRIVATE-TOKEN": self.token,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise GitLabError(f"GitLab {exc.code} bei {method} {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise GitLabError(f"GitLab nicht erreichbar: {exc.reason}") from exc

    def _project_path(self, project_id: str) -> str:
        return urllib.parse.quote(f"{self.group}/{project_id}", safe="")

    def ensure_repo(self, project: Project) -> dict[str, Any]:
        path = self._project_path(project.id)
        try:
            return self._request("GET", f"/projects/{path}")
        except GitLabError:
            self._request(
                "POST",
                "/projects",
                {
                    "name": project.name,
                    "path": project.id,
                    "description": project.description,
                    "namespace_id": self._group_id(),
                },
            )
            return self._request("GET", f"/projects/{path}")

    def _group_id(self) -> int:
        encoded = urllib.parse.quote(self.group, safe="")
        group = self._request("GET", f"/groups/{encoded}")
        return group["id"]

    def list_issues(self, project: Project) -> list[dict[str, Any]]:
        return self._request("GET", f"/projects/{self._project_path(project.id)}/issues")

    def ensure_issue(self, project: Project, item_id: str, title: str, priority: str, status: str) -> dict[str, Any]:
        for issue in self.list_issues(project):
            if issue["title"].startswith(f"[{item_id}] "):
                self._request(
                    "PUT",
                    f"/projects/{self._project_path(project.id)}/issues/{issue['iid']}",
                    {
                        "title": f"[{item_id}] {title}",
                        "state_event": "close" if status == "fertig" else "reopen",
                        "labels": [ISSUE_LABELS[status], f"{PRIORITY_PREFIX}{priority}"],
                    },
                )
                return self._request(
                    "GET",
                    f"/projects/{self._project_path(project.id)}/issues/{issue['iid']}",
                )
        return self._request(
            "POST",
            f"/projects/{self._project_path(project.id)}/issues",
            {
                "title": f"[{item_id}] {title}",
                "labels": [ISSUE_LABELS[status], f"{PRIORITY_PREFIX}{priority}"],
            },
        )

    def close_issue(self, project: Project, item_id: str) -> None:
        for issue in self.list_issues(project):
            if issue["title"].startswith(f"[{item_id}] "):
                self._request(
                    "PUT",
                    f"/projects/{self._project_path(project.id)}/issues/{issue['iid']}",
                    {"state_event": "close"},
                )
                return

    def ensure_group(self) -> None:
        self._group_id()


def client_from_env() -> GitLabClient:
    url = os.environ.get("GITLAB_URL", "https://gitlab.com")
    token = os.environ.get("GITLAB_TOKEN", "")
    group = os.environ.get("GITLAB_GROUP", "")
    if not token or not group:
        raise GitLabError(
            "GITLAB_TOKEN und GITLAB_GROUP müssen gesetzt sein "
            "(optional GITLAB_URL, Standard https://gitlab.com)."
        )
    return GitLabClient(url, token, group)


def sync_project(client: GitLabClient, project: Project) -> dict[str, Any]:
    """Synchronisiert ein pp-Projekt in sein GitLab-Repo (Issue je Eintrag)."""

    client.ensure_group()
    client.ensure_repo(project)
    created, updated = 0, 0
    existing = {i["title"][1:].split("] ", 1)[0] for i in client.list_issues(project)}
    for item in project.items:
        before = item.id in existing
        client.ensure_issue(project, item.id, item.title, item.priority, item.status)
        if before:
            updated += 1
        else:
            created += 1
    return {
        "project": project.id,
        "repo": f"{client.group}/{project.id}",
        "created": created,
        "updated": updated,
    }
