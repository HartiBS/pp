"""Tests für OAuth-Helfer und Session-Verwaltung."""

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pp.auth import (
    OAuthConfig, SessionStore, decode_cookie, encode_cookie, user_allowed,
)


class SessionStoreTest(unittest.TestCase):
    def test_state_roundtrip(self) -> None:
        store = SessionStore()
        state = store.new_state()
        self.assertTrue(store.pop_state(state))
        self.assertFalse(store.pop_state(state))

    def test_state_single_use(self) -> None:
        store = SessionStore()
        state = store.new_state()
        self.assertTrue(store.pop_state(state))
        self.assertFalse(store.pop_state(state))

    def test_session_roundtrip(self) -> None:
        store = SessionStore()
        token = store.create({"login": "alice"})
        session = store.get(token)
        self.assertEqual(session["user"]["login"], "alice")
        store.drop(token)
        self.assertIsNone(store.get(token))

    def test_unknown_session(self) -> None:
        store = SessionStore()
        self.assertIsNone(store.get("ungueltig"))


class CookieTest(unittest.TestCase):
    def test_encode_decode(self) -> None:
        token = "abc123"
        header = encode_cookie(token)
        self.assertIn("HttpOnly", header)
        self.assertIn("SameSite=Lax", header)
        self.assertEqual(decode_cookie(header), token)

    def test_decode_multiple_cookies(self) -> None:
        header = "other=1; pp_session=xyz; foo=bar"
        self.assertEqual(decode_cookie(header), "xyz")

    def test_decode_missing(self) -> None:
        self.assertIsNone(decode_cookie(None))
        self.assertIsNone(decode_cookie(""))

    def test_decode_other_only(self) -> None:
        self.assertIsNone(decode_cookie("session=1"))


class AccessControlTest(unittest.TestCase):
    def _config(self, users="", orgs="") -> OAuthConfig:
        return OAuthConfig("id", "secret",
                           [u for u in users.split(",") if u],
                           [o for o in orgs.split(",") if o])

    def test_open_for_all_when_unrestricted(self) -> None:
        config = self._config()
        self.assertTrue(user_allowed(config, {"login": "anyone"}))

    def test_allowed_user_match(self) -> None:
        config = self._config(users="alice,bob")
        self.assertTrue(user_allowed(config, {"login": "Alice"}))

    def test_allowed_user_no_match(self) -> None:
        config = self._config(users="alice,bob")
        self.assertFalse(user_allowed(config, {"login": "eve"}))


if __name__ == "__main__":
    unittest.main()
