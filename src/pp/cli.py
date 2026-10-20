"""CLI zur Verwaltung agiler Projekte."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .model import PRIORITIES, STATUSES, Item, Project
from .store import Store
from .web import serve
DEFAULT_DB = Path("projects.json")


def _store(db: Path) -> Store:
    return Store(db)


def cmd_project_add(args: argparse.Namespace, store: Store) -> None:
    store.add_project(Project(id=args.id, name=args.name, description=args.description or ""))
    print(f"Projekt {args.id!r} angelegt.")


def cmd_project_list(_args: argparse.Namespace, store: Store) -> None:
    projects = store.list_projects()
    if not projects:
        print("Keine Projekte.")
        return
    for p in projects:
        line = f"{p.id}\t{p.name}"
        if p.description:
            line += f"\t{p.description}"
        print(line)


def cmd_item_add(args: argparse.Namespace, store: Store) -> None:
    project = store.get_project(args.project)
    if project is None:
        sys.exit(f"Projekt {args.project!r} nicht gefunden.")
    project.add_item(
        Item(id=args.id, project_id=project.id, title=args.title, priority=args.priority)
    )
    store.save()
    print(f"Eintrag {args.id!r} zu {project.id!r} hinzugefügt.")


def cmd_item_move(args: argparse.Namespace, store: Store) -> None:
    project = store.get_project(args.project)
    if project is None:
        sys.exit(f"Projekt {args.project!r} nicht gefunden.")
    try:
        item = project.move_item(args.item, args.status)
    except KeyError as exc:
        sys.exit(str(exc))
    except ValueError as exc:
        sys.exit(str(exc))
    store.save()
    print(f"Eintrag {item.id!r} -> {item.status}.")


def cmd_item_list(args: argparse.Namespace, store: Store) -> None:
    project = store.get_project(args.project)
    if project is None:
        sys.exit(f"Projekt {args.project!r} nicht gefunden.")
    items = project.items
    if args.status:
        items = [i for i in items if i.status == args.status]
    if args.priority:
        items = [i for i in items if i.priority == args.priority]
    if not items:
        print("Keine Einträge gefunden.")
        return
    for item in items:
        print(f"[{item.status:8}] [{item.priority:6}] {item.id}: {item.title}")


def cmd_board(args: argparse.Namespace, store: Store) -> None:
    project = store.get_project(args.project)
    if project is None:
        sys.exit(f"Projekt {args.project!r} nicht gefunden.")
    print(f"Board: {project.name} ({project.id})")
    print()
    for status in STATUSES:
        items = [i for i in project.items if i.status == status]
        print(f"=== {status} ({len(items)}) ===")
        for item in items:
            print(f"  [{item.priority:6}] {item.id}: {item.title}")
        print()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pp", description="Agile Projekte verwalten")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Pfad zur JSON-Datenbank")
    sub = parser.add_subparsers(dest="command", required=True)

    p_project = sub.add_parser("project", help="Projekte verwalten")
    p_sub = p_project.add_subparsers(dest="subcommand", required=True)
    p_add = p_sub.add_parser("add", help="Projekt anlegen")
    p_add.add_argument("id")
    p_add.add_argument("name")
    p_add.add_argument("--description", "-d", default="")
    p_add.set_defaults(func=cmd_project_add)
    p_list = p_sub.add_parser("list", help="Projekte auflisten")
    p_list.set_defaults(func=cmd_project_list)

    p_item = sub.add_parser("item", help="Backlog-Einträge verwalten")
    i_sub = p_item.add_subparsers(dest="subcommand", required=True)
    i_add = i_sub.add_parser("add", help="Eintrag hinzufügen")
    i_add.add_argument("project")
    i_add.add_argument("id")
    i_add.add_argument("title")
    i_add.add_argument("--priority", choices=("hoch", "mittel", "niedrig"), default="mittel")
    i_add.set_defaults(func=cmd_item_add)
    i_move = i_sub.add_parser("move", help="Eintrag in anderen Status verschieben")
    i_move.add_argument("project")
    i_move.add_argument("item")
    i_move.add_argument("status", choices=STATUSES)
    i_move.set_defaults(func=cmd_item_move)
    i_list = i_sub.add_parser("list", help="Einträge auflisten (optional gefiltert)")
    i_list.add_argument("project")
    i_list.add_argument("--status", choices=STATUSES)
    i_list.add_argument("--priority", choices=PRIORITIES)
    i_list.set_defaults(func=cmd_item_list)

    p_board = sub.add_parser("board", help="Board eines Projekts anzeigen")
    p_board.add_argument("project")
    p_board.set_defaults(func=cmd_board)

    p_serve = sub.add_parser("serve", help="HTML5-Board im Browser starten")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.set_defaults(func=cmd_serve)

    return parser


def cmd_serve(args: argparse.Namespace, store: Store) -> None:
    serve(args.host, args.port, store.path)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    store = _store(args.db)
    try:
        args.func(args, store)
    except ValueError as exc:
        sys.exit(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
