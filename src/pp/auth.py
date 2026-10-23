"""GitHub-OAuth-Authentifizierung für den Boardserver."""

from __future__ import annotations

import base64
import json
import os
import secrets
import time
import urllib.parse
import urllib.request
from typing import Any

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"

SESSION_COOKIE = "pp_session"
SESSION_TTL = 12 * 60 * 60
STATE_TTL = 10 * 60


class OAuthConfig:
    def __init__(self, client_id: str, client_secret: str, allowed_users: list[str],
                 allowed_orgs: list[str]) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.allowed_users = {u.lower() for u in allowed_users}
        self.allowed_orgs = set(allowed_orgs)

    @classmethod
    def from_env(cls) -> "OAuthConfig | None":
        client_id = os.environ.get("GITHUB_CLIENT_ID", "")
        client_secret = os.environ.get("GITHUB_CLIENT_SECRET", "")
        if not client_id or not client_secret:
            return None
        return cls(
            client_id=client_id,
            client_secret=client_secret,
            allowed_users=[u.strip() for u in os.environ.get("GITHUB_ALLOWED_USERS", "").split(",") if u.strip()],
            allowed_orgs=[o.strip() for o in os.environ.get("GITHUB_ALLOWED_ORGS", "").split(",") if o.strip()],
        )


class SessionStore:
    """In-Memory-Sessions plus OAuth-States (CSRF-Schutz)."""

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._states: dict[str, float] = {}

    def new_state(self) -> str:
        self._gc()
        state = secrets.token_urlsafe(24)
        self._states[state] = time.time()
        return state

    def pop_state(self, state: str) -> bool:
        created = self._states.pop(state, None)
        return created is not None and time.time() - created < STATE_TTL

    def create(self, user: dict[str, Any]) -> str:
        self._gc()
        token = secrets.token_urlsafe(32)
        self._sessions[token] = {"user": user, "created": time.time()}
        return token

    def get(self, token: str) -> dict[str, Any] | None:
        session = self._sessions.get(token)
        if session is None or time.time() - session["created"] > SESSION_TTL:
            self._sessions.pop(token, None)
            return None
        return session

    def drop(self, token: str) -> None:
        self._sessions.pop(token, None)

    def _gc(self) -> None:
        now = time.time()
        self._states = {s: t for s, t in self._states.items() if now - t < STATE_TTL}
        self._sessions = {t: s for t, s in self._sessions.items() if now - s["created"] < SESSION_TTL}


def exchange_code(config: OAuthConfig, code: str) -> str:
    data = urllib.parse.urlencode({
        "client_id": config.client_id,
        "client_secret": config.client_secret,
        "code": code,
    }).encode()
    req = urllib.request.Request(
        GITHUB_TOKEN_URL,
        data=data,
        headers={"Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as response:
        payload = json.loads(response.read().decode())
    token = payload.get("access_token")
    if not token:
        raise ValueError(f"GitHub-Token-Austausch fehlgeschlagen: {payload}")
    return token


def fetch_user(access_token: str) -> dict[str, Any]:
    req = urllib.request.Request(
        GITHUB_USER_URL,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode())


def user_allowed(config: OAuthConfig, user: dict[str, Any]) -> bool:
    if not config.allowed_users and not config.allowed_orgs:
        return True
    if user.get("login", "").lower() in config.allowed_users:
        return True
    return False


def authorize_url(config: OAuthConfig, state: str, redirect_uri: str) -> str:
    params = urllib.parse.urlencode({
        "client_id": config.client_id,
        "redirect_uri": redirect_uri,
        "scope": "read:user",
        "state": state,
    })
    return f"{GITHUB_AUTHORIZE_URL}?{params}"


def decode_cookie(header_value: str | None) -> str | None:
    if not header_value or "=" not in header_value:
        return None
    for part in header_value.split(";"):
        name, _, value = part.strip().partition("=")
        if name == SESSION_COOKIE and value:
            return value
    return None


def encode_cookie(token: str) -> str:
    return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax"
