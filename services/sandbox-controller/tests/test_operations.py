"""The seven lifecycle endpoints beyond `create`, against a fake Modal."""

from __future__ import annotations

import pytest
from modal import exception as modal_exception

from modal.stream_type import StreamType

import sandboxes
from images import BOOTSTRAP_ENV_KEY

from tests.fakes import FakeModal, create_spec, headers

REFERENCE = {"sessionId": "sess_1", "generation": 1}


@pytest.fixture
def started(client, modal_fake: FakeModal):
    client.post("/v1/create", json=create_spec(), headers=headers())
    return client


def test_start_confirms_the_generation_exists(started) -> None:
    """Modal starts a sandbox as part of creating it, so this endpoint's whole
    job is to make a create that never landed visible."""
    response = started.post("/v1/start", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": REFERENCE}


def test_start_refuses_a_generation_that_was_never_created(client) -> None:
    response = client.post("/v1/start", json=REFERENCE, headers=headers())

    assert response.status_code == 404
    assert response.json()["category"] == "not_found"


def test_status_reports_a_running_sandbox_as_active(started) -> None:
    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": "active"}


def test_status_for_a_generation_that_was_terminated_is_stopped(
    started, modal_fake: FakeModal
) -> None:
    """A finished sandbox is invisible to `Sandbox.from_name`, so the status is
    read from the generation's listing, which includes finished sandboxes."""
    modal_fake.sandboxes[0].terminate()

    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": "stopped"}


def test_status_for_a_generation_that_exited_with_an_error_is_failed(
    started, modal_fake: FakeModal
) -> None:
    sandbox = modal_fake.sandboxes[0]
    sandbox.terminated = True
    sandbox.exit_code = 3

    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": "failed"}


def test_status_for_a_generation_modal_never_had_is_not_found(client) -> None:
    response = client.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.status_code == 404
    assert response.json()["category"] == "not_found"


def test_status_ignores_a_finished_sandbox_with_the_tags_but_another_name(
    started, modal_fake: FakeModal
) -> None:
    """The tags are only a filter; the name decides."""
    modal_fake.sandboxes[0].terminate()
    modal_fake.sandboxes[0].name = "someone-elses"

    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.status_code == 404


def test_a_nonzero_exit_is_reported_as_failed(started, modal_fake: FakeModal) -> None:
    """The window `state_of` exists for: the lookup found the sandbox and it
    finished before `poll()`. Exit 1, because 137 is what OnCue's own
    `terminate()` produces."""
    modal_fake.sandboxes[0].exit_code = 1

    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": "failed"}


def test_a_zero_exit_in_that_same_window_is_reported_as_stopped(
    started, modal_fake: FakeModal
) -> None:
    modal_fake.sandboxes[0].exit_code = 0

    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": "stopped"}


@pytest.mark.parametrize("operation", ["stop", "destroy"])
def test_stopping_terminates_the_sandbox(started, modal_fake: FakeModal, operation: str) -> None:
    response = started.post(f"/v1/{operation}", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": REFERENCE}
    assert modal_fake.sandboxes[0].terminated is True


@pytest.mark.parametrize("operation", ["stop", "destroy"])
def test_stopping_something_already_gone_still_succeeds(client, operation: str) -> None:
    """A retried stop whose first response was lost has to converge, not report
    a failure the Worker cannot act on."""
    response = client.post(f"/v1/{operation}", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": REFERENCE}


def test_execute_runs_the_command_line_and_returns_an_opaque_handle(
    started, modal_fake: FakeModal
) -> None:
    response = started.post(
        "/v1/execute",
        json={"reference": REFERENCE, "command": {"commandLine": "pnpm test", "timeoutMs": 5000}},
        headers=headers(),
    )

    body = response.json()
    assert body["kind"] == "ok"
    assert body["value"]["executionId"].startswith("sb-s-sess_1-g1-")
    args, kwargs = modal_fake.sandboxes[0].execs[0]
    assert args == ("/bin/sh", "-c", "pnpm test")
    assert kwargs["timeout"] == 5


def test_execute_discards_both_output_streams(started, modal_fake: FakeModal) -> None:
    """Modal defaults both streams to pipes and nobody reads them, so a command
    with real output would stall. The bridge carries command output."""
    started.post(
        "/v1/execute",
        json={"reference": REFERENCE, "command": {"commandLine": "pnpm test", "timeoutMs": 5000}},
        headers=headers(),
    )

    _args, kwargs = modal_fake.sandboxes[0].execs[0]
    assert kwargs["stdout"] is StreamType.DEVNULL
    assert kwargs["stderr"] is StreamType.DEVNULL


def test_a_sub_second_timeout_still_asks_for_at_least_one_second(
    started, modal_fake: FakeModal
) -> None:
    started.post(
        "/v1/execute",
        json={"reference": REFERENCE, "command": {"commandLine": "true", "timeoutMs": 10}},
        headers=headers(),
    )

    _args, kwargs = modal_fake.sandboxes[0].execs[0]
    assert kwargs["timeout"] == 1


def test_create_does_not_pass_the_deprecated_environment_to_the_sandbox(
    client, modal_fake: FakeModal
) -> None:
    """`Sandbox.create`'s `environment_name` is deprecated and ignored in 1.5.5;
    the environment comes from the App `ensure_app` looked up."""
    client.post("/v1/create", json=create_spec(), headers=headers(environment="staging"))

    _args, kwargs = modal_fake.create_calls[0]
    assert "environment_name" not in kwargs
    assert modal_fake.apps_looked_up == [("oncue-sessions", "staging")]


def test_get_connection_addresses_the_sandbox_and_returns_no_credential(started) -> None:
    """The bridge dials the Durable Object outbound, so there is no socket to
    hand back -- and a stateless controller could not return the bootstrap
    credential it was given at create even if it were allowed to."""
    response = started.post("/v1/getConnection", json=REFERENCE, headers=headers())

    assert response.json() == {
        "kind": "ok",
        "value": {"bridgeUrl": "modal://oncue-sessions/sb-s-sess_1-g1"},
    }
    assert "bootstrapCredential" not in response.text


def test_checkpoint_returns_the_snapshot_image_id(started) -> None:
    response = started.post("/v1/createCheckpoint", json=REFERENCE, headers=headers())

    assert response.json() == {"kind": "ok", "value": {"checkpointId": "im-snapshot"}}


@pytest.mark.parametrize(
    "path",
    ["start", "stop", "destroy", "getStatus", "execute", "getConnection", "createCheckpoint"],
)
def test_every_endpoint_needs_authentication(client, path: str) -> None:
    body = (
        {"reference": REFERENCE, "command": {"commandLine": "true", "timeoutMs": 1000}}
        if path == "execute"
        else REFERENCE
    )

    response = client.post(f"/v1/{path}", json=body, headers=headers(controller_token=None))

    assert response.status_code == 401


def test_a_sigkill_exit_after_terminate_is_stopped_not_failed(started, modal_fake: FakeModal) -> None:
    """Modal's terminate sends SIGKILL, so `poll()` returns 137 after it. A
    sandbox OnCue stopped on purpose must not be reported as failed."""
    sandbox = modal_fake.sandboxes[0]
    sandbox.exit_code = 137
    response = started.post("/v1/getStatus", json=REFERENCE, headers=headers())
    assert response.json() == {"kind": "ok", "value": "stopped"}


def test_execute_unsets_the_bootstrap_credential_in_the_exec_environment(
    started, modal_fake: FakeModal
) -> None:
    """A `Sandbox.exec` process inherits the container's base environment,
    Secret included, whatever uid it runs as. The controller's own exec must
    not carry it."""
    started.post(
        "/v1/execute",
        json={"reference": REFERENCE, "command": {"commandLine": "true", "timeoutMs": 1000}},
        headers=headers(),
    )
    _args, kwargs = modal_fake.sandboxes[0].execs[-1]
    assert kwargs["env"] == {BOOTSTRAP_ENV_KEY: None}


from datetime import datetime as _datetime, timedelta as _timedelta, timezone as _timezone

# Recent, because the first request looks back one hour from now; fixed once so
# a cursor compared against a stamp is compared against the same clock.
_BASE = _datetime.now(_timezone.utc) - _timedelta(minutes=5)


def _stamp(seconds: float):
    return _BASE + _timedelta(seconds=seconds)


def test_get_output_relays_the_entrypoint_lines_with_a_cursor(started, modal_fake: FakeModal) -> None:
    """Each line once, in order, with the instant to ask from next."""
    from tests.fakes import FakeLogEntry

    sandbox = modal_fake.sandboxes[0]
    sandbox.printed.extend(
        [
            FakeLogEntry("bridge starting\n", _stamp(1), "stdout"),
            FakeLogEntry("bridge could not reach the control plane\n", _stamp(2), "stderr"),
            FakeLogEntry("", _stamp(2.5), "stdout"),
        ]
    )

    first = started.post(
        "/v1/getOutput", json={"reference": REFERENCE, "since": None}, headers=headers()
    )
    assert first.status_code == 200
    body = first.json()
    assert body["kind"] == "ok"
    assert [line["text"] for line in body["value"]["lines"]] == [
        "bridge starting",
        "bridge could not reach the control plane",
    ]
    assert [line["stream"] for line in body["value"]["lines"]] == ["stdout", "stderr"]
    cursor = body["value"]["next"]
    assert cursor > _stamp(2).isoformat()

    sandbox.printed.append(FakeLogEntry("bridge finished: shutdown\n", _stamp(5), "stdout"))
    second = started.post(
        "/v1/getOutput", json={"reference": REFERENCE, "since": cursor}, headers=headers()
    )
    assert [line["text"] for line in second.json()["value"]["lines"]] == [
        "bridge finished: shutdown"
    ]


def test_get_output_with_nothing_new_leaves_the_cursor_where_it_was(started, modal_fake: FakeModal) -> None:
    """A line Modal surfaces late is stamped when it was printed, so an empty
    poll must not move the cursor past it."""
    from tests.fakes import FakeLogEntry

    # The first poll has no cursor; its window opens FIRST_OUTPUT_WINDOW back
    # and, with nothing printed, stays open there.
    first = started.post(
        "/v1/getOutput", json={"reference": REFERENCE, "since": None}, headers=headers()
    ).json()["value"]
    assert first["lines"] == []
    assert first["next"] < _stamp(0).isoformat()

    cursor = _stamp(1).isoformat()
    empty = started.post(
        "/v1/getOutput", json={"reference": REFERENCE, "since": cursor}, headers=headers()
    )
    body = empty.json()["value"]
    assert body["lines"] == []
    assert body["next"] == cursor

    # Printed at +2s, surfaced after the empty poll: still found from the same cursor.
    modal_fake.sandboxes[0].printed.append(FakeLogEntry("late line\n", _stamp(2), "stdout"))
    later = started.post(
        "/v1/getOutput", json={"reference": REFERENCE, "since": body["next"]}, headers=headers()
    )
    assert [line["text"] for line in later.json()["value"]["lines"]] == ["late line"]


def test_get_output_for_a_generation_not_running_is_not_found(client) -> None:
    response = client.post(
        "/v1/getOutput", json={"reference": REFERENCE, "since": None}, headers=headers()
    )
    assert response.status_code == 404
    assert response.json()["category"] == "not_found"


def test_parse_since_reads_a_zulu_instant_and_a_naive_one_as_utc() -> None:
    from datetime import datetime, timezone

    now = datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert sandboxes.parse_since("2026-09-10T11:00:00Z", now).tzinfo is not None
    assert sandboxes.parse_since("2026-09-10T11:00:00", now).isoformat() == "2026-09-10T11:00:00+00:00"
    assert sandboxes.parse_since(None, now) == now - sandboxes.FIRST_OUTPUT_WINDOW


def test_every_route_runs_on_the_thread_pool() -> None:
    """The Modal SDK's calls block. An `async def` route making them would
    hold the event loop, so one slow create or image build would stall every
    other request; a plain `def` route runs on FastAPI's thread pool."""
    import inspect

    import app as controller

    routes = [route for route in controller.api.routes if route.path.startswith("/v1/")]
    assert routes
    for route in routes:
        assert not inspect.iscoroutinefunction(route.endpoint), route.path
    # Modal admits no more at once than the pool has threads for.
    assert controller.CONCURRENT_REQUESTS < 40


def test_two_requests_are_served_at_once(client, modal_fake: FakeModal) -> None:
    """A create waits behind nothing: while one request is held inside Modal,
    another is answered."""
    import threading

    gate = threading.Event()
    entered = threading.Event()
    original = modal_fake.sandbox_create

    def held(*args, **kwargs):
        entered.set()
        gate.wait(timeout=10)
        return original(*args, **kwargs)

    modal_fake.sandbox_create = held  # type: ignore[method-assign]
    results: list[int] = []
    slow = threading.Thread(
        target=lambda: results.append(
            client.post("/v1/create", json=create_spec(), headers=headers()).status_code
        )
    )
    slow.start()
    assert entered.wait(timeout=10)

    quick = client.post("/v1/getStatus", json={"sessionId": "other", "generation": 1}, headers=headers())

    assert quick.status_code == 404
    gate.set()
    slow.join(timeout=10)
    assert results == [200]
