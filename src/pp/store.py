"""JSON-Datei-Speicher für Projekte."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .model import Project


class Store:
    """Lädt und speichert Projekte in einer JSON-Datei."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._projects: dict[str, Project] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        for data in raw.get("projects", []):
            project = Project.from_dict(data)
            self._projects[project.id] = project

    def save(self) -> None:
        data: dict[str, Any] = {
            "projects": [p.to_dict() for p in self._projects.values()]
        }
        self.path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def add_project(self, project: Project) -> None:
        if project.id in self._projects:
            raise ValueError(f"Projekt {project.id!r} existiert bereits")
        self._projects[project.id] = project
        self.save()

    def get_project(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def list_projects(self) -> list[Project]:
        return list(self._projects.values())
