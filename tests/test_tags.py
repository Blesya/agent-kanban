"""Task tags: normalisation, store queries, REST and MCP surfaces."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from kanban_mcp import server
from kanban_store.store import normalize_tags
from kanban_ui import main

# --------------------------------------------------------------- store


def test_normalize_tags_lowercases_dedupes_and_sorts():
    assert normalize_tags(["UI", " Bug Fix ", "ui"]) == ["bug-fix", "ui"]
    assert normalize_tags(None) == []


def test_normalize_tags_rejects_unusable_values():
    with pytest.raises(ValueError, match="longer than"):
        normalize_tags(["x" * 40])
    with pytest.raises(ValueError, match="invalid tag"):
        normalize_tags(["bad!tag"])
    with pytest.raises(ValueError, match=r"tags\[1\]"):
        normalize_tags(["ok", "bad!tag"])


def test_store_tags_on_create_update_and_filter(store):
    t = store.create_task("card", project_id="proj", tags=["UI", "bug-fix"])
    assert t.tags == ["bug-fix", "ui"]
    assert [x.id for x in store.list_tasks(tag="UI")] == [t.id]
    assert store.list_tasks(tag="missing") == []

    store.create_task("second", project_id="proj", tags=["ui"])
    assert store.list_tags("proj") == [
        {"name": "ui", "count": 2},
        {"name": "bug-fix", "count": 1},
    ]

    updated = store.update_fields(t.id, actor="user", tags=["api"])
    assert updated.tags == ["api"]
    assert t.id not in [x.id for x in store.list_tasks(tag="ui")]

    before = len(store.get_task(t.id).history)
    store.update_fields(t.id, actor="user", tags=["API"])   # same set, new case
    assert len(store.get_task(t.id).history) == before

    store.update_fields(t.id, actor="user", tags=[])
    assert store.get_task(t.id).tags == []


def test_store_tags_are_project_scoped(store):
    store.create_project("other", "Other")
    store.create_task("mine", project_id="proj", tags=["ui"])
    store.create_task("theirs", project_id="other", tags=["ui", "api"])
    assert [x["name"] for x in store.list_tags("proj")] == ["ui"]
    assert {x["name"] for x in store.list_tags("other")} == {"api", "ui"}
    assert {x["name"] for x in store.list_tags()} == {"api", "ui"}


def test_archived_cards_still_provide_tags(store):
    t = store.create_task("old", project_id="proj", tags=["legacy"])
    store.archive_task(t.id, actor="user")
    assert [x["name"] for x in store.list_tags("proj")] == ["legacy"]
    assert store.list_tags("proj", include_archived=False) == []


# ----------------------------------------------------------------- API


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        if main._store.get_project("tags") is None:
            main._store.create_project("tags", "Tags")
        yield c


def _new(client, **kw):
    r = client.post("/api/tasks", json={"title": "task", "project_id": "tags", **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_api_create_board_and_patch(client):
    t = _new(client, tags=["UI", "Bug Fix"])
    assert t["tags"] == ["bug-fix", "ui"]

    board = client.get("/api/board", params={"project": "tags"}).json()
    card = next(c for c in board["tasks"]["backlog"] if c["id"] == t["id"])
    assert card["tags"] == ["bug-fix", "ui"]

    r = client.patch(f"/api/tasks/{t['id']}", json={"tags": ["api"]})
    assert r.status_code == 200 and r.json()["tags"] == ["api"]

    r = client.patch(f"/api/tasks/{t['id']}", json={"tags": []})
    assert r.status_code == 200 and r.json()["tags"] == []


def test_api_rejects_bad_tags(client):
    r = client.post(
        "/api/tasks", json={"title": "x", "project_id": "tags", "tags": ["no way!"]}
    )
    assert r.status_code == 400 and "invalid tag" in r.json()["detail"]

    t = _new(client)
    r = client.patch(f"/api/tasks/{t['id']}", json={"tags": ["y" * 40]})
    assert r.status_code == 400 and "longer than" in r.json()["detail"]


def test_api_tag_vocabulary(client):
    t = _new(client, tags=["vocab-a", "vocab-b"])
    r = client.get("/api/tags", params={"project": "tags"})
    assert r.status_code == 200
    vocab = {x["name"]: x["count"] for x in r.json()["tags"]}
    assert vocab["vocab-a"] == 1 and vocab["vocab-b"] == 1

    client.post(f"/api/tasks/{t['id']}/archive", json={"archived": True})
    vocab = {x["name"] for x in client.get("/api/tags", params={"project": "tags"}).json()["tags"]}
    assert {"vocab-a", "vocab-b"} <= vocab
    live = {
        x["name"]
        for x in client.get(
            "/api/tags", params={"project": "tags", "include_archived": False}
        ).json()["tags"]
    }
    assert "vocab-a" not in live


def test_api_tag_endpoint_unknown_project(client):
    assert client.get("/api/tags", params={"project": "nope"}).status_code == 404


# ----------------------------------------------------------------- MCP


@pytest.fixture
def mcp_store(store, monkeypatch):
    monkeypatch.setattr(server, "_store", store)
    monkeypatch.delenv("KANBAN_ACTOR", raising=False)
    monkeypatch.delenv("KANBAN_PROJECT_ID", raising=False)
    return store


async def _call(name: str, **args):
    content, _structured = await server.mcp.call_tool(name, args)
    return json.loads(content[0].text)


@pytest.mark.asyncio
async def test_mcp_create_list_search_update_tags(mcp_store):
    created = await _call(
        "kanban_create", title="bug", tags=["UI", "Bug Fix"], project_id="proj"
    )
    assert created["ok"] and created["data"]["tags"] == ["bug-fix", "ui"]
    task_id = created["data"]["id"]

    listed = await _call("kanban_list", tag="UI", project_id="proj")
    assert [t["id"] for t in listed["data"]["tasks"]] == [task_id]

    by_tag = await _call("kanban_search", tag="bug-fix", project_id="proj")
    assert by_tag["ok"] and by_tag["data"]["count"] == 1

    by_text = await _call("kanban_search", query="bug-", project_id="proj")
    assert by_text["data"]["count"] == 1

    short = await _call("kanban_search", project_id="proj")
    assert short["ok"] is False and "at least 2 characters" in short["error"]

    tags = await _call("kanban_tags", project_id="proj")
    assert {x["name"] for x in tags["data"]["tags"]} == {"bug-fix", "ui"}

    updated = await _call("kanban_update", task_id=task_id, tags=["api"])
    assert updated["data"]["tags"] == ["api"]

    cleared = await _call("kanban_update", task_id=task_id, tags=[])
    assert cleared["data"]["tags"] == []
