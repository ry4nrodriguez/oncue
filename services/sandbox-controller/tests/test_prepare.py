"""Image preparation: `/v1/prepareImage` and `prepare.Preparer`.

A cold build takes minutes, so a request never waits for one past its bound;
the build continues on the controller's pool and a later request collects it.
"""

from __future__ import annotations

import threading

import pytest
from modal import exception as modal_exception

import app as controller
import prepare
from tests.fakes import FakeModal, headers


@pytest.fixture(autouse=True)
def fresh_preparer(monkeypatch: pytest.MonkeyPatch) -> prepare.Preparer:
    """Each test gets its own memory, as a freshly started controller would."""
    preparer = prepare.Preparer()
    monkeypatch.setattr(controller, "preparer", preparer)
    return preparer


def test_a_warm_workspace_answers_ready_with_the_image_id(client, modal_fake: FakeModal) -> None:
    response = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())

    assert response.json() == {
        "kind": "ok",
        "value": {"state": "ready", "imageReference": "im-built-v1", "imageVersion": "v1"},
    }
    assert modal_fake.builds == ["app:oncue-sessions"]


def test_the_build_runs_in_the_callers_environment(client, modal_fake: FakeModal) -> None:
    client.post(
        "/v1/prepareImage", json={"waitMs": 5_000}, headers=headers(environment="staging")
    )

    assert modal_fake.apps_looked_up == [("oncue-sessions", "staging")]


def test_a_second_call_is_answered_from_memory_without_building_again(
    client, modal_fake: FakeModal
) -> None:
    client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    again = client.post("/v1/prepareImage", json={}, headers=headers())

    assert again.json()["value"]["state"] == "ready"
    assert len(modal_fake.builds) == 1


def test_a_slow_build_answers_building_and_a_later_call_collects_it(
    client, modal_fake: FakeModal
) -> None:
    modal_fake.build_gate = threading.Event()

    first = client.post("/v1/prepareImage", json={"waitMs": 0}, headers=headers())
    joined = client.post("/v1/prepareImage", json={"waitMs": 0}, headers=headers())
    modal_fake.build_gate.set()
    collected = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())

    assert first.json()["value"] == {"state": "building", "imageVersion": "v1"}
    assert joined.json()["value"]["state"] == "building"
    assert collected.json()["value"]["state"] == "ready"
    # The second call joined the build under way rather than starting another.
    assert len(modal_fake.builds) == 1


def test_a_new_image_version_is_built_again(client, modal_fake: FakeModal) -> None:
    client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    modal_fake.image_version_value = "v2"

    response = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())

    assert response.json()["value"]["imageReference"] == "im-built-v2"
    assert len(modal_fake.builds) == 2


def test_each_workspace_is_prepared_on_its_own(client, modal_fake: FakeModal) -> None:
    """Modal caches an image per workspace, so one user's warm image says
    nothing about another's."""
    client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    client.post(
        "/v1/prepareImage", json={"waitMs": 5_000}, headers=headers(token_id="ak-other-user")
    )
    client.post(
        "/v1/prepareImage", json={"waitMs": 5_000}, headers=headers(environment="staging")
    )

    assert len(modal_fake.builds) == 3


def test_a_failed_build_is_reported_and_the_next_call_tries_again(
    client, modal_fake: FakeModal
) -> None:
    modal_fake.raise_on_build = modal_exception.ImageBuildError("layer 3 failed", image_id="im-failed")

    failed = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    retried = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())

    assert failed.status_code == 500
    assert failed.json()["category"] == "image_preparation"
    assert "layer 3" not in failed.text
    assert retried.json()["value"]["state"] == "ready"
    assert len(modal_fake.builds) == 2


def test_the_wait_is_capped(monkeypatch: pytest.MonkeyPatch, modal_fake: FakeModal) -> None:
    """A caller asking to wait longer than the cap is answered at the cap, so
    no request outlives the Worker's deadline for it."""
    monkeypatch.setattr(prepare, "MAX_WAIT_MS", 50)
    modal_fake.build_gate = threading.Event()
    preparer = prepare.Preparer()

    answer = preparer.prepare(modal_fake.api(), object(), None, "key", 10_000_000)

    assert answer["state"] == "building"
    modal_fake.build_gate.set()


def test_memory_is_bounded(modal_fake: FakeModal) -> None:
    preparer = prepare.Preparer(remembered=2)
    for key in ("a", "b", "c"):
        preparer.prepare(modal_fake.api(), object(), None, key, 5_000)

    preparer.prepare(modal_fake.api(), object(), None, "a", 5_000)

    # "a" was the oldest and was forgotten, so it was built a second time.
    assert len(modal_fake.builds) == 4


def test_a_recently_used_image_is_kept(modal_fake: FakeModal) -> None:
    preparer = prepare.Preparer(remembered=2)
    preparer.prepare(modal_fake.api(), object(), None, "a", 5_000)
    preparer.prepare(modal_fake.api(), object(), None, "b", 5_000)
    preparer.prepare(modal_fake.api(), object(), None, "a", 5_000)
    preparer.prepare(modal_fake.api(), object(), None, "c", 5_000)

    preparer.prepare(modal_fake.api(), object(), None, "a", 5_000)

    assert len(modal_fake.builds) == 3


def test_prepare_requires_the_callers_credential(client) -> None:
    response = client.post("/v1/prepareImage", json={}, headers=headers(token_id=None))

    assert response.status_code == 401


def test_prepare_refuses_an_unknown_field(client) -> None:
    response = client.post("/v1/prepareImage", json={"imageId": "im-x"}, headers=headers())

    assert response.status_code == 400


def test_two_callers_at_once_join_one_build(modal_fake: FakeModal) -> None:
    """Both ask while the build is held, so neither can be answered from the
    memory of a finished build: the second must join the first's."""
    modal_fake.build_gate = threading.Event()
    preparer = prepare.Preparer()
    answers: list[dict] = []

    def ask() -> None:
        answers.append(preparer.prepare(modal_fake.api(), object(), None, "key", 0))

    callers = [threading.Thread(target=ask) for _ in range(2)]
    for caller in callers:
        caller.start()
    for caller in callers:
        caller.join(timeout=10)
    assert [answer["state"] for answer in answers] == ["building", "building"]
    while len(modal_fake.builds) < 1:
        threading.Event().wait(0.01)
    assert len(modal_fake.builds) == 1

    modal_fake.build_gate.set()
    collected = preparer.prepare(modal_fake.api(), object(), None, "key", 5_000)

    assert collected["state"] == "ready"
    assert len(modal_fake.builds) == 1


def test_a_build_that_never_finishes_is_forgotten_after_a_while(
    monkeypatch: pytest.MonkeyPatch, modal_fake: FakeModal
) -> None:
    """A hung build keeps its thread, but not the workspace's preparation: the
    next request after `BUILD_FORGET_AFTER_S` starts another."""
    now = [1_000.0]
    monkeypatch.setattr(prepare, "monotonic", lambda: now[0])
    modal_fake.build_gate = threading.Event()
    preparer = prepare.Preparer()

    preparer.prepare(modal_fake.api(), object(), None, "key", 0)
    # The clock starts when the build begins to run, so wait for that.
    while len(modal_fake.builds) < 1:
        threading.Event().wait(0.01)
    now[0] += prepare.BUILD_FORGET_AFTER_S - 1
    preparer.prepare(modal_fake.api(), object(), None, "key", 0)
    builds_before = len(modal_fake.builds)
    now[0] += 2
    preparer.prepare(modal_fake.api(), object(), None, "key", 0)
    modal_fake.build_gate.set()

    while len(modal_fake.builds) < 2:
        threading.Event().wait(0.01)
    assert builds_before == 1
    assert len(modal_fake.builds) == 2


def test_a_build_waiting_for_a_worker_is_not_forgotten(
    monkeypatch: pytest.MonkeyPatch, modal_fake: FakeModal
) -> None:
    """With every worker busy a build can wait longer than
    `BUILD_FORGET_AFTER_S` before it starts. It is not hung, and starting it
    again would queue a duplicate behind it."""
    now = [1_000.0]
    monkeypatch.setattr(prepare, "monotonic", lambda: now[0])
    modal_fake.build_gate = threading.Event()
    preparer = prepare.Preparer(workers=1)

    preparer.prepare(modal_fake.api(), object(), None, "busy", 0)
    while len(modal_fake.builds) < 1:
        threading.Event().wait(0.01)
    queued = preparer.prepare(modal_fake.api(), object(), None, "queued", 0)
    now[0] += prepare.BUILD_FORGET_AFTER_S + 1
    still_queued = preparer.prepare(modal_fake.api(), object(), None, "queued", 0)
    modal_fake.build_gate.set()
    collected = preparer.prepare(modal_fake.api(), object(), None, "queued", 5_000)

    assert queued["state"] == "building"
    assert still_queued["state"] == "building"
    assert collected["state"] == "ready"
    # One build for each key: the queued one was never submitted a second time.
    assert len(modal_fake.builds) == 2


def test_a_build_that_raises_a_timeout_is_a_failure_not_a_build_under_way(
    client, modal_fake: FakeModal
) -> None:
    """A build's own `TimeoutError` is the class the wait raises when it runs
    out. Read as `building`, it would be started again on every poll."""
    modal_fake.raise_on_build = TimeoutError("the read timed out")

    failed = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    retried = client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())

    assert failed.json()["kind"] == "error"
    assert "the read timed out" not in failed.text
    assert retried.json()["value"]["state"] == "ready"
    assert len(modal_fake.builds) == 2


def test_each_workspace_is_built_with_its_own_client(client, modal_fake: FakeModal) -> None:
    """The build's App is looked up with the requesting workspace's client, so
    the image lands in, and bills, that workspace."""
    client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    client.post(
        "/v1/prepareImage", json={"waitMs": 5_000}, headers=headers(token_id="ak-other-user")
    )

    assert [found.token_id for found in modal_fake.app_lookup_clients] == [
        "ak-caller-token-id",
        "ak-other-user",
    ]


def test_a_pair_differing_only_in_its_secret_is_prepared_on_its_own(
    client, modal_fake: FakeModal
) -> None:
    client.post("/v1/prepareImage", json={"waitMs": 5_000}, headers=headers())
    client.post(
        "/v1/prepareImage", json={"waitMs": 5_000}, headers=headers(token_secret="as-rotated")
    )

    assert len(modal_fake.builds) == 2
