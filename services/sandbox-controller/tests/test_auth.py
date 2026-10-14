"""Two credentials, two jobs: the bearer says the caller is OnCue, the
`x-oncue-modal-*` headers say which workspace to act in. Neither substitutes
for the other, and the controller creates paid compute, so every way of
arriving without both has to be refused."""

from __future__ import annotations

import pytest

import app as controller
from tests.fakes import CONTROLLER_TOKEN, FakeModal, create_spec, headers


def test_a_correct_bearer_and_credentials_are_accepted(client, modal_fake: FakeModal) -> None:
    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 200
    assert len(modal_fake.clients) == 1


@pytest.mark.parametrize(
    "sent",
    [
        pytest.param(headers(controller_token=None), id="no bearer at all"),
        pytest.param(headers(controller_token="wrong-token"), id="wrong bearer"),
        pytest.param(headers(token_id=None), id="no caller token id"),
        pytest.param(headers(token_secret=None), id="no caller token secret"),
    ],
)
def test_requests_missing_either_credential_are_refused(
    client, modal_fake: FakeModal, sent: dict[str, str]
) -> None:
    response = client.post("/v1/create", json=create_spec(), headers=sent)

    assert response.status_code == 401
    assert response.json() == {
        "kind": "error",
        "category": "credentials",
        "message": "This request is not authenticated.",
        "retryable": False,
    }
    assert modal_fake.sandboxes == []


def test_an_authorization_header_that_is_not_a_bearer_is_refused(client) -> None:
    response = client.post(
        "/v1/create",
        json=create_spec(),
        headers={**headers(controller_token=None), "authorization": f"Basic {CONTROLLER_TOKEN}"},
    )

    assert response.status_code == 401


def test_a_controller_with_no_token_configured_accepts_nobody(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Failing closed rather than open. A missing Secret must leave a broken
    deployment, not an open sandbox factory."""
    monkeypatch.delenv(controller.CONTROLLER_TOKEN_ENV_KEY)

    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 401


def test_a_blank_controller_token_counts_as_absent(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A half-filled deployment config produces `""`, and comparing a bearer
    against the empty string would accept `Bearer `."""
    monkeypatch.setenv(controller.CONTROLLER_TOKEN_ENV_KEY, "   ")

    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 401


def test_the_callers_own_token_pair_builds_the_client(client, modal_fake: FakeModal) -> None:
    """The controller holds no Modal credential. Whatever arrives in the
    headers is what every Modal call for this request runs on."""
    client.post("/v1/create", json=create_spec(), headers=headers())

    built = modal_fake.clients[0]
    assert (built.token_id, built.token_secret) == (
        "ak-caller-token-id",
        "as-caller-token-secret",
    )
    for _args, kwargs in modal_fake.create_calls:
        assert kwargs["client"] is built


def test_the_environment_header_is_optional_and_defaults_to_none(
    client, modal_fake: FakeModal
) -> None:
    client.post("/v1/create", json=create_spec(), headers=headers())

    assert modal_fake.apps_looked_up == [("oncue-sessions", None)]


def test_a_body_the_controller_cannot_read_does_not_echo_it_back(client) -> None:
    response = client.post(
        "/v1/create",
        json={"sessionId": "sess_1", "surprise": "value-from-the-body"},
        headers=headers(),
    )

    assert response.status_code == 400
    assert response.json()["category"] == "configuration"
    assert "value-from-the-body" not in response.text
