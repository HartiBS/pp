"""Minimaler Webserver: JSON-API + HTML5-Board für die Projekte."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .model import STATUSES
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
        if self.path != "/api/move":
            self._send_json({"error": "nicht gefunden"}, 404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "ungültiges JSON"}, 400)
            return

        project = self.store.get_project(payload.get("project_id", ""))
        if project is None:
            self._send_json({"error": "Projekt nicht gefunden"}, 404)
            return
        try:
            item = project.move_item(payload.get("item_id", ""), payload.get("status", ""))
        except (KeyError, ValueError) as exc:
            self._send_json({"error": str(exc)}, 400)
            return
        self.store.save()
        self._send_json(item.to_dict())

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
