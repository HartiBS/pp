"""Minimaler Webserver: JSON-API + HTML5-Board für die Projekte."""

from __future__ import annotations

import json
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .auth import (
    OAuthConfig, SESSION_COOKIE, SessionStore, authorize_url, decode_cookie,
    encode_cookie, exchange_code, fetch_user, user_allowed,
)
from .model import PRIORITIES, STATUSES, Item, Project
from .gitlab_sync import GitLabClient, GitLabError, sync_project
from .store import Store

class BoardConfig:
    def __init__(self, oauth: OAuthConfig | None, base_url: str) -> None:
        self.oauth = oauth
        self.base_url = base_url.rstrip("/")

WEB_DIR = Path(__file__).resolve().parent / "web"


class Handler(BaseHTTPRequestHandler):
    store: Store
    sessions: SessionStore
    oauth: OAuthConfig | None
    base_url: str

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

    def _session_user(self, path_is_public: bool) -> dict | None:
        if self.oauth is None:
            return {"login": "local", "public": True}
        token = decode_cookie(self.headers.get("Cookie"))
        session = self.sessions.get(token) if token else None
        if session is not None:
            return session["user"]
        return None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/auth/login" and self.oauth is not None:
            state = self.sessions.new_state()
            url = authorize_url(self.oauth, state, self.base_url + "/auth/callback")
            self.send_response(302)
            self.send_header("Location", url)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/auth/callback") and self.oauth is not None:
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            state = params.get("state", [""])[0]
            code = params.get("code", [""])[0]
            if not code or not self.sessions.pop_state(state):
                self._send_json({"error": "ungültiger OAuth-Callback"}, 400)
                return
            try:
                access_token = exchange_code(self.oauth, code)
                user = fetch_user(access_token)
            except (ValueError, OSError) as exc:
                self._send_json({"error": f"GitHub-Login fehlgeschlagen: {exc}"}, 502)
                return
            if not user_allowed(self.oauth, user):
                self._send_json({"error": "Zugang nicht erlaubt"}, 403)
                return
            token = self.sessions.create(user)
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", encode_cookie(token))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/auth/logout":
            token = decode_cookie(self.headers.get("Cookie"))
            if token:
                self.sessions.drop(token)
            if self.oauth is None:
                self._send_json({"ok": True})
            else:
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; Max-Age=0")
                self.send_header("Content-Length", "0")
                self.end_headers()
            return
        if self.oauth is not None and self._session_user(False) is None:
            if self.path.startswith("/api/"):
                self._send_json({"error": "nicht angemeldet"}, 401)
            else:
                self.send_response(302)
                self.send_header("Location", "/auth/login")
                self.send_header("Content-Length", "0")
                self.end_headers()
            return
        if self.path in ("/", "/index.html"):
            self._send_html((WEB_DIR / "index.html").read_bytes())
        elif self.path == "/api/projects":
            self._send_json([p.to_dict() for p in self.store.list_projects()])
        elif self.path == "/api/statuses":
            self._send_json(list(STATUSES))
        else:
            self._send_json({"error": "nicht gefunden"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.oauth is not None and self._session_user(False) is None:
            self._send_json({"error": "nicht angemeldet"}, 401)
            return
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


def serve(host: str, port: int, db: Path, oauth: OAuthConfig | None = None,
          base_url: str | None = None) -> None:
    handler = type("BoundHandler", (Handler,), {
        "store": Store(db),
        "sessions": SessionStore(),
        "oauth": oauth,
        "base_url": (base_url or f"http://{host}:{port}").rstrip("/"),
    })
    server = ThreadingHTTPServer((host, port), handler)
    mode = "GitHub-Login aktiv" if oauth else "lokaler Modus ohne Login"
    print(f"pp-Board: http://{host}:{port}  ({mode}, Strg+C zum Beenden)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer gestoppt.")
    finally:
        server.server_close()
