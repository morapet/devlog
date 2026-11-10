"""Private VPN mode (DEVLOG_AUTH=private-vpn) — the allow decision.

Run with:  uv run --with pytest pytest tests
"""

import pytest

from devlog import auth, vpn

PEER = "100.84.0.5"
OWNER = {"Node": {}, "UserProfile": {"LoginName": "Alice@GitHub"}}
STRANGER = {"Node": {}, "UserProfile": {"LoginName": "mallory@github"}}
TAGGED = {"Node": {"Tags": ["tag:laptop"]}, "UserProfile": {"LoginName": "tagged-devices"}}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for k in ("DEVLOG_VPN_USERS", "DEVLOG_VPN_TAGS", "DEVLOG_VPN_CIDRS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEVLOG_AUTH", "private-vpn")
    monkeypatch.setenv("DEVLOG_AUTH_TOKEN", "s3cret")
    vpn._cache.clear()


def peers(monkeypatch, table):
    calls = []

    def fake(ip):
        calls.append(ip)
        return table.get(ip)

    monkeypatch.setattr(vpn, "_whois_raw", fake)
    return calls


def allowed(host, headers=None):
    return auth.request_allowed(path="/tasks", client_host=host, cookies={}, headers=headers or {})


def test_listed_user_is_allowed_case_insensitively(monkeypatch):
    monkeypatch.setenv("DEVLOG_VPN_USERS", "bob@example.com, alice@github")
    peers(monkeypatch, {PEER: OWNER})
    assert allowed(PEER)
    assert not auth.auth_required_for(PEER)


def test_other_tailnet_user_is_rejected(monkeypatch):
    monkeypatch.setenv("DEVLOG_VPN_USERS", "alice@github")
    peers(monkeypatch, {PEER: STRANGER})
    assert not allowed(PEER)
    assert auth.auth_required_for(PEER)


def test_unknown_address_is_rejected_but_token_still_works(monkeypatch):
    monkeypatch.setenv("DEVLOG_VPN_USERS", "alice@github")
    peers(monkeypatch, {})
    assert not allowed("203.0.113.9")
    assert allowed("203.0.113.9", {"authorization": "Bearer s3cret"})


def test_tagged_device_needs_its_tag_listed(monkeypatch):
    # The placeholder login of a tagged device must never match a user entry.
    monkeypatch.setenv("DEVLOG_VPN_USERS", "tagged-devices")
    peers(monkeypatch, {PEER: TAGGED})
    assert not allowed(PEER)
    monkeypatch.setenv("DEVLOG_VPN_TAGS", "tag:laptop")
    assert allowed(PEER)


def test_cidr_trusts_without_asking_tailscale(monkeypatch):
    monkeypatch.setenv("DEVLOG_VPN_CIDRS", "10.8.0.0/24, not-a-network")
    calls = peers(monkeypatch, {})
    assert allowed("10.8.0.7")
    assert not allowed("10.9.0.7")
    assert calls == []


def test_nothing_configured_trusts_nobody(monkeypatch):
    calls = peers(monkeypatch, {PEER: OWNER})
    assert not allowed(PEER)
    assert calls == []


def test_lookups_are_cached(monkeypatch):
    monkeypatch.setenv("DEVLOG_VPN_USERS", "alice@github")
    calls = peers(monkeypatch, {PEER: OWNER})
    assert allowed(PEER) and allowed(PEER)
    assert calls == [PEER]


def test_other_modes_ignore_vpn_identity(monkeypatch):
    monkeypatch.setenv("DEVLOG_VPN_USERS", "alice@github")
    peers(monkeypatch, {PEER: OWNER})
    for mode in ("auto", "always"):
        monkeypatch.setenv("DEVLOG_AUTH", mode)
        assert not allowed(PEER)


def test_loopback_and_public_paths_unchanged(monkeypatch):
    peers(monkeypatch, {})
    assert allowed("127.0.0.1")
    assert auth.request_allowed(path="/health", client_host="203.0.113.9", cookies={}, headers={})
