"""Datenmodell für Projekte und Backlog-Einträge."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

STATUSES = ("offen", "in_arbeit", "pruefung", "fertig")
PRIORITIES = ("hoch", "mittel", "niedrig")


def _validate_choice(value: str, choices: tuple[str, ...], label: str) -> str:
    if value not in choices:
        raise ValueError(f"Unbekannter {label}: {value!r} (erlaubt: {', '.join(choices)})")
    return value


@dataclass
class Item:
    """Backlog-Eintrag eines Projekts."""

    id: str
    project_id: str
    title: str
    status: str = "offen"
    priority: str = "mittel"

    def __post_init__(self) -> None:
        _validate_choice(self.status, STATUSES, "Status")
        _validate_choice(self.priority, PRIORITIES, "Priorität")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Item":
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            title=data["title"],
            status=data["status"],
            priority=data["priority"],
        )


@dataclass
class Project:
    """Agiles Projekt mit Backlog."""

    id: str
    name: str
    description: str = ""
    items: list[Item] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.id or not self.name:
            raise ValueError("Projekt benötigt id und name")

    def add_item(self, item: Item) -> None:
        if any(i.id == item.id for i in self.items):
            raise ValueError(f"Eintrag {item.id!r} existiert bereits in {self.id!r}")
        item.project_id = self.id
        self.items.append(item)

    def find_item(self, item_id: str) -> Item | None:
        return next((i for i in self.items if i.id == item_id), None)

    def move_item(self, item_id: str, status: str) -> Item:
        item = self.find_item(item_id)
        if item is None:
            raise KeyError(f"Eintrag {item_id!r} nicht gefunden")
        item.status = _validate_choice(status, STATUSES, "Status")
        return item

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "items": [i.to_dict() for i in self.items],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Project":
        project = cls(id=data["id"], name=data["name"], description=data.get("description", ""))
        for item_data in data.get("items", []):
            project.items.append(Item.from_dict(item_data))
        return project
