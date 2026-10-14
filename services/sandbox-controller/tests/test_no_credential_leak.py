"""Every request is driven with distinctive credential values, and everything
the controller emits (response bodies, log records, and the arguments that
reach Modal) is searched for those bytes."""

from __future__ import annotations

import logging

import pytest
from modal import exception as modal_exception

import app as controller
from tests.fakes import CALLER_TOKEN_ID, CALLER_TOKEN_SECRET, FakeModal, create_spec, headers

REFERENCE = {"sessionId": "sess_1", "generation": 1}

SECRETS = (CALLER_TOKEN_ID, CALLER_TOKEN_SECRET, "boot_sess_1_1")


def every_request(client) -> list[str]:
    """One pass over all eight operations and the credential test, plus the
    failure path."""
    bodies = [
        client.post("/v1/connection/test", headers=headers()).text,
        client.post("/v1/create", json=create_spec(), headers=headers()).text,
        client.post("/v1/start", json=REFERENCE, headers=headers()).text,
        client.post("/v1/getStatus", json=REFERENCE, headers=headers()).text,
        client.post(
            "/v1/execute",
            json={
                "reference": REFERENCE,
                "command": {"commandLine": "true", "timeoutMs": 1000},
            },
            headers=headers(),
        ).text,
        client.post("/v1/getConnection", json=REFERENCE, headers=headers()).text,
        client.post("/v1/createCheckpoint", json=REFERENCE, headers=headers()).text,
        client.post("/v1/stop", json=REFERENCE, headers=headers()).text,
        client.post("/v1/destroy", json=REFERENCE, headers=headers()).text,
    ]
    return bodies


def test_no_response_body_carries_a_credential(client) -> None:
    for body in every_request(client):
        for secret in SECRETS:
            assert secret not in body


def test_no_log_line_carries_a_credential(
    client, modal_fake: FakeModal, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="oncue.sandbox-controller"):
        every_request(client)
        modal_fake.raise_on_create = modal_exception.AuthError(CALLER_TOKEN_SECRET)
        client.post("/v1/create", json=create_spec(generation=9), headers=headers())

    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert "result=failed" in emitted
    for secret in SECRETS:
        assert secret not in emitted


def test_a_provider_message_containing_a_credential_does_not_reach_the_caller(
    client, modal_fake: FakeModal
) -> None:
    """The reason `errors.py` never derives a message from `str(exc)`."""
    modal_fake.raise_on_create = modal_exception.AuthError(CALLER_TOKEN_SECRET)

    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 401
    assert CALLER_TOKEN_SECRET not in response.text


def test_the_modal_token_never_reaches_the_sandbox(client, modal_fake: FakeModal) -> None:
    """Record 02: the token pair builds a client and goes no further; it is not
    among the created sandbox's secrets, environment, or tags."""
    client.post("/v1/create", json=create_spec(), headers=headers())

    _args, kwargs = modal_fake.create_calls[0]
    rendered = repr({key: value for key, value in kwargs.items() if key != "client"})
    assert CALLER_TOKEN_ID not in rendered
    assert CALLER_TOKEN_SECRET not in rendered


def test_the_controller_keeps_nothing_between_requests(client, modal_fake: FakeModal) -> None:
    """Record 02: the controller is stateless apart from Modal's own object
    state."""
    client.post("/v1/create", json=create_spec(), headers=headers())
    modal_fake.sandboxes.clear()

    response = client.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.status_code == 404


def test_a_client_factory_that_leaks_is_still_translated(client, modal_fake, caplog):
    """The one Modal call that receives the raw credential is a FastAPI
    dependency, outside `guarded`. An untranslated exception there reaches
    Starlette's traceback log with `str(exc)`, and Modal's gRPC metadata
    validation errors can name the rejected value."""
    caplog.set_level(logging.DEBUG)

    def leaks(token_id: str, token_secret: str):
        raise RuntimeError(f"bad credential {token_id}:{token_secret}")

    modal_fake.client_factory = leaks

    response = client.post("/v1/getStatus", json=REFERENCE, headers=headers())

        # A bare RuntimeError is `unknown`; what matters is that an envelope
        # came back rather than a 500 and a logged traceback.
    body = response.json()
    assert body["kind"] == "error"
    assert body["category"] in ("unknown", "credentials")
    emitted = response.text + "\n".join(record.getMessage() for record in caplog.records)
    for secret in SECRETS:
        assert secret not in emitted


def test_a_rejected_credential_is_reported_as_a_credential_failure(client, modal_fake, caplog):
    """The failure users actually hit, and the one Modal is most likely to
    describe using the value it rejected."""
    caplog.set_level(logging.DEBUG)

    def rejects(token_id: str, token_secret: str):
        raise modal_exception.AuthError(f"token {token_id}/{token_secret} was rejected")

    modal_fake.client_factory = rejects

    response = client.post("/v1/getStatus", json=REFERENCE, headers=headers())

    assert response.status_code == 401
    assert response.json()["category"] == "credentials"
    emitted = response.text + "\n".join(record.getMessage() for record in caplog.records)
    for secret in SECRETS:
        assert secret not in emitted
