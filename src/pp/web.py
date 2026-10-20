"""Minimaler Webserver: JSON-API + HTML5-Board für die Projekte."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .model import PRIORITIES, STATUSES, Item, Project
from .gitlab_sync import GitLabClient, GitLabError, sync_project
from .store import Store

WEB_DIR = Path(__file__).resolve().parent / "web"


class Handler(BaseHTTPRequestHandler):
    store: Store

    def _send_json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: bytes, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/index.html"):
            self._send_html((WEB_DIR / "index.html").read_bytes())
        elif self.path == "/api/projects":
            self._send_json([p.to_dict() for p in self.store.list_projects()])
        elif self.path == "/api/statuses":
            self._send_json(list(STATUSES))
        else:
            self._send_json({"error": "nicht gefunden"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/api/projects", "/api/items", "/api/move", "/api/update", "/api/delete", "/api/sync"):
            self._send_json({"error": "nicht gefunden"}, 404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "ungültiges JSON"}, 400)
            return
        try:
            if self.path == "/api/projects":
                self._add_project(payload)
            elif self.path == "/api/items":
                self._add_item(payload)
            elif self.path == "/api/move":
                self._move_item(payload)
            elif self.path == "/api/update":
                self._update_item(payload)
            elif self.path == "/api/sync":
                self._sync(payload)
            else:
                self._delete_item(payload)
        except (KeyError, ValueError) as exc:
            self._send_json({"error": str(exc)}, 400)
            return
        self.store.save()

    def _project_or_fail(self, project_id: str) -> Project:
        project = self.store.get_project(project_id)
        if project is None:
            raise KeyError(f"Projekt {project_id!r} nicht gefunden")
        return project

    def _add_project(self, payload: dict) -> None:
        project = Project(
            id=payload["id"], name=payload["name"], description=payload.get("description", "")
        )
        self.store.add_project(project)
        self._send_json(project.to_dict(), 201)

    def _add_item(self, payload: dict) -> None:
        project = self._project_or_fail(payload["project_id"])
        item = Item(
            id=payload["id"],
            project_id=project.id,
            title=payload["title"],
            priority=payload.get("priority", "mittel"),
        )
        project.add_item(item)
        self._send_json(item.to_dict(), 201)

    def _move_item(self, payload: dict) -> None:
        project = self._project_or_fail(payload["project_id"])
        item = project.move_item(payload["item_id"], payload["status"])
        self._send_json(item.to_dict())

    def _update_item(self, payload: dict) -> None:
        project = self._project_or_fail(payload["project_id"])
        item = project.find_item(payload["item_id"])
        if item is None:
            raise KeyError(f"Eintrag {payload['item_id']!r} nicht gefunden")
        if "title" in payload:
            title = payload["title"].strip()
            if not title:
                raise ValueError("Titel darf nicht leer sein")
            item.title = title
        if "priority" in payload:
            item.priority = payload["priority"]
        self._send_json(item.to_dict())

    def _sync(self, payload: dict) -> None:
        url = payload.get("url") or "https://gitlab.com"
        token = (payload.get("token") or "").strip()
        group = (payload.get("group") or "").strip()
        if not token or not group:
            raise ValueError("GitLab-Gruppe und -Token sind erforderlich")
        client = GitLabClient(url, token, group)
        project_id = payload.get("project_id")
        if project_id:
            projects = [self._project_or_fail(project_id)]
        else:
            projects = self.store.list_projects()
            if not projects:
                self._send_json({"results": [], "error": "Keine Projekte vorhanden"})
                return
        results = []
        try:
            for project in projects:
                results.append(sync_project(client, project))
        except GitLabError as exc:
            self._send_json({"error": str(exc), "results": results}, 400)
            return
        self._send_json({"results": results})

    def _delete_item(self, payload: dict) -> None:
        project = self._project_or_fail(payload["project_id"])
        item = project.find_item(payload["item_id"])
        if item is None:
            raise KeyError(f"Eintrag {payload['item_id']!r} nicht gefunden")
        project.items.remove(item)
        self._send_json({"deleted": item.id})

    def log_message(self, format: str, *args: object) -> None:
        pass


def serve(host: str, port: int, db: Path) -> None:
    handler = type("BoundHandler", (Handler,), {"store": Store(db)})
    server = ThreadingHTTPServer((host, port), handler)
    print(f"pp-Board: http://{host}:{port}  (Strg+C zum Beenden)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer gestoppt.")
    finally:
        server.server_close()
