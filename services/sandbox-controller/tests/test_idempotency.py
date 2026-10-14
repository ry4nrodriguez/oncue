"""Record 02: "Its calls are idempotent using the session identifier and
generation number, so a retried create does not produce two sandboxes."

Modal has no create-or-get, so idempotency here is a three-step dance and each
step has its own way of going wrong. These tests cover all three: the retry
that finds the sandbox already there, the retry that races and loses, and the
neighbouring generation that must NOT be treated as the same sandbox.
"""

from __future__ import annotations

from modal import exception as modal_exception

from tests.fakes import FakeModal, create_spec, headers


def test_retried_create_returns_the_same_sandbox(client, modal_fake: FakeModal) -> None:
    first = client.post("/v1/create", json=create_spec(), headers=headers())
    second = client.post("/v1/create", json=create_spec(), headers=headers())

    assert first.status_code == 200
    assert first.json() == {"kind": "ok", "value": {"sessionId": "sess_1", "generation": 1}}
    assert second.json() == first.json()
    assert len(modal_fake.sandboxes) == 1
    assert len(modal_fake.create_calls) == 1


def test_a_create_that_loses_the_race_returns_the_winners_sandbox(
    client, modal_fake: FakeModal
) -> None:
    """The Worker retried a create whose response was lost, and something else
    had already made the sandbox. `AlreadyExistsError` is the only signal, and
    the second lookup is what turns it back into a successful retry."""
    winner = modal_fake.sandbox_create(name="s-sess_1-g1", tags={})
    # The lookup ahead of the create has to miss for the race to be exercised
    # at all, so this test forces the miss and lets the create meet the winner.
    modal_fake.raise_on_from_name = modal_exception.NotFoundError("s-sess_1-g1")

    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 200
    assert len(modal_fake.sandboxes) == 1
    assert modal_fake.sandboxes[0] is winner


def test_a_conflict_with_nothing_behind_it_is_reported_rather_than_swallowed(
    client, modal_fake: FakeModal
) -> None:
    """`AlreadyExistsError` with no sandbox to find afterwards means something
    the controller does not understand happened. Reporting a conflict is right;
    inventing a success is not."""
    modal_fake.raise_on_create = modal_exception.AlreadyExistsError("s-sess_1-g1")

    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 409
    assert response.json()["category"] == "conflict"


def test_a_second_generation_is_a_second_sandbox(client, modal_fake: FakeModal) -> None:
    client.post("/v1/create", json=create_spec(generation=1), headers=headers())
    client.post("/v1/create", json=create_spec(generation=2), headers=headers())

    assert sorted(sandbox.name for sandbox in modal_fake.sandboxes) == [
        "s-sess_1-g1",
        "s-sess_1-g2",
    ]


def test_the_app_is_looked_up_with_create_if_missing(client, modal_fake: FakeModal) -> None:
    """A user's workspace has no `oncue-sessions` App until OnCue makes one,
    and `Sandbox.from_name` needs a DEPLOYED App to look in."""
    client.post("/v1/create", json=create_spec(), headers=headers(environment="staging"))

    assert modal_fake.apps_looked_up == [("oncue-sessions", "staging")]


def test_a_retry_after_the_sandbox_exited_refuses_rather_than_starting_a_second(
    client, modal_fake: FakeModal
) -> None:
    """A finished sandbox frees its name, so a lookup by name misses and Modal
    would accept a second create. The generation's listing still holds the
    finished one, and that is the refusal."""
    client.post("/v1/create", json=create_spec(), headers=headers())
    modal_fake.sandboxes[0].terminate()

    retried = client.post("/v1/create", json=create_spec(), headers=headers())

    assert retried.status_code == 409
    assert retried.json()["category"] == "conflict"
    assert retried.json()["retryable"] is False
    assert len(modal_fake.sandboxes) == 1
    assert len(modal_fake.create_calls) == 1


def test_a_finished_sandbox_of_another_generation_does_not_block_this_one(
    client, modal_fake: FakeModal
) -> None:
    client.post("/v1/create", json=create_spec(generation=1), headers=headers())
    modal_fake.sandboxes[0].terminate()

    response = client.post("/v1/create", json=create_spec(generation=2), headers=headers())

    assert response.status_code == 200
    assert len(modal_fake.sandboxes) == 2


def test_nothing_is_started_after_the_callers_deadline(client, modal_fake: FakeModal) -> None:
    """The Worker stopped waiting at `notAfter` and would not know about a
    sandbox started later, so none is started; the refusal is retryable."""
    spec = {**create_spec(), "notAfter": "2000-01-01T00:00:00Z"}

    response = client.post("/v1/create", json=spec, headers=headers())

    assert response.status_code == 500
    assert response.json()["category"] == "unknown"
    assert response.json()["retryable"] is True
    assert modal_fake.create_calls == []


def test_a_create_inside_the_deadline_goes_ahead(client, modal_fake: FakeModal) -> None:
    spec = {**create_spec(), "notAfter": "2999-01-01T00:00:00+00:00"}

    response = client.post("/v1/create", json=spec, headers=headers())

    assert response.status_code == 200
    assert len(modal_fake.sandboxes) == 1


def test_a_deadline_without_a_zone_is_read_as_utc(client, modal_fake: FakeModal) -> None:
    spec = {**create_spec(), "notAfter": "2000-01-01T00:00:00"}

    response = client.post("/v1/create", json=spec, headers=headers())

    assert response.status_code == 500
    assert modal_fake.create_calls == []


def test_a_running_sandbox_is_returned_even_past_the_deadline(
    client, modal_fake: FakeModal
) -> None:
    """A retry that finds the sandbox running starts nothing, so the deadline
    does not apply."""
    client.post("/v1/create", json=create_spec(), headers=headers())
    spec = {**create_spec(), "notAfter": "2000-01-01T00:00:00Z"}

    response = client.post("/v1/create", json=spec, headers=headers())

    assert response.status_code == 200
    assert len(modal_fake.create_calls) == 1


def test_a_prepared_image_id_is_used_instead_of_building(client, modal_fake: FakeModal) -> None:
    spec = {**create_spec(), "imageReference": "im-prepared"}

    client.post("/v1/create", json=spec, headers=headers())

    assert modal_fake.images_from_id == ["im-prepared"]
    assert modal_fake.create_calls[0][1]["image"] == "image:im-prepared"
    assert modal_fake.builds == []


def test_an_older_workers_reference_builds_the_image_inside_create(
    client, modal_fake: FakeModal
) -> None:
    """A Worker deployed before preparation existed sends no image id; create
    falls back to the image definition, as it always did."""
    client.post("/v1/create", json=create_spec(), headers=headers())

    assert modal_fake.images_from_id == []
    assert modal_fake.create_calls[0][1]["image"].__class__.__name__ == "FakeImageDefinition"


def test_a_sandbox_modal_finishes_creating_after_the_deadline_is_stopped(
    client, modal_fake: FakeModal, monkeypatch
) -> None:
    """The deadline passed while `Sandbox.create` was out: the caller has
    stopped waiting and its stop sweep may have looked already, so the
    controller stops the sandbox itself."""
    from datetime import datetime, timezone

    import sandboxes

    readings = iter(
        [
            datetime(2026, 10, 1, 0, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 10, 1, 0, 1, 0, tzinfo=timezone.utc),
        ]
    )
    monkeypatch.setattr(sandboxes, "clock", lambda: next(readings))
    spec = {**create_spec(), "notAfter": "2026-10-01T00:00:30Z"}

    response = client.post("/v1/create", json=spec, headers=headers())

    assert response.status_code == 500
    assert response.json()["retryable"] is False
    assert len(modal_fake.sandboxes) == 1
    assert modal_fake.sandboxes[0].terminated is True


def test_a_raced_create_past_the_deadline_leaves_the_winners_sandbox_alone(
    client, modal_fake: FakeModal, monkeypatch
) -> None:
    """Only this request's own sandbox is stopped; the winner of a race is
    another request's, whose caller may still be waiting for it."""
    from datetime import datetime, timezone

    import sandboxes

    winner = modal_fake.sandbox_create(name="s-sess_1-g1", tags={})
    modal_fake.raise_on_from_name = modal_exception.NotFoundError("s-sess_1-g1")
    readings = iter(
        [
            datetime(2026, 10, 1, 0, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 10, 1, 0, 1, 0, tzinfo=timezone.utc),
        ]
    )
    monkeypatch.setattr(sandboxes, "clock", lambda: next(readings))
    spec = {**create_spec(), "notAfter": "2026-10-01T00:00:30Z"}

    response = client.post("/v1/create", json=spec, headers=headers())

    assert response.status_code == 200
    assert winner.terminated is False
