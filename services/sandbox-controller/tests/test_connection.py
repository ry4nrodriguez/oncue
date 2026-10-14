"""The credential test's three stages, each failing on its own.

The stages are ordered so that the cheapest question that can rule the
credential out is asked first, and each case below drives exactly one of them
into failure. The `no_environment_access` pair matters most: that is what a
Modal service user looks like on the day it is created, and it is the one
failure a user will meet with a credential that is otherwise perfectly good.
"""

from __future__ import annotations

import pytest
from modal import exception as modal_exception

import connection
from tests.fakes import CALLER_TOKEN_ID, CALLER_TOKEN_SECRET, FakeModal, headers

PATH = "/v1/connection/test"


def test_a_working_credential_reports_the_workspace_and_its_environments(
    client, modal_fake: FakeModal
) -> None:
    modal_fake.environments = ["main", "staging"]
    modal_fake.workspace_name = "acme-workspace"

    response = client.post(PATH, headers=headers())

    assert response.status_code == 200
    assert response.json() == {
        "kind": "ok",
        "value": {"workspaceName": "acme-workspace", "environments": ["main", "staging"]},
    }


def test_the_workspace_is_hydrated_before_its_name_is_read(
    client, modal_fake: FakeModal
) -> None:
    """`.name` is `None` on an unhydrated workspace, so the hydrate call is
    load-bearing rather than defensive. Without it this endpoint would report a
    null name for every credential that works."""
    client.post(PATH, headers=headers())

    assert [workspace.hydrated for workspace in modal_fake.workspaces] == [True]


def test_a_credential_modal_does_not_recognise_is_invalid(
    client, modal_fake: FakeModal
) -> None:
    modal_fake.raise_on_list_environments = modal_exception.AuthError("nope")

    response = client.post(PATH, headers=headers())

    assert response.status_code == 200
    assert response.json() == {"kind": "failed", "reason": connection.INVALID_CREDENTIALS}


def test_a_credential_that_can_see_no_environment_is_named_as_such(
    client, modal_fake: FakeModal
) -> None:
    """The service-user default: Modal grants No Access on every Environment
    until somebody assigns a role, so the credential is genuine and useless."""
    modal_fake.environments = []

    response = client.post(PATH, headers=headers())

    assert response.status_code == 200
    assert response.json() == {"kind": "failed", "reason": connection.NO_ENVIRONMENT_ACCESS}


def test_a_permission_denied_is_no_environment_access_rather_than_invalid(
    client, modal_fake: FakeModal
) -> None:
    """Modal accepted the credential and then refused the action, which is the
    same problem the empty list describes and has the same fix."""
    modal_fake.raise_on_list_environments = modal_exception.PermissionDeniedError("no role")

    response = client.post(PATH, headers=headers())

    assert response.json() == {"kind": "failed", "reason": connection.NO_ENVIRONMENT_ACCESS}


@pytest.mark.parametrize(
    "raised",
    [
        pytest.param(modal_exception.ConnectionError("no route"), id="transport"),
        pytest.param(modal_exception.RemoteError("modal is unwell"), id="server side"),
        pytest.param(RuntimeError("an SDK shape nobody expected"), id="untranslated"),
    ],
)
def test_anything_else_leaves_the_controller_unable_to_say(
    client, modal_fake: FakeModal, raised: BaseException
) -> None:
    modal_fake.raise_on_workspace = raised

    response = client.post(PATH, headers=headers())

    assert response.json() == {"kind": "failed", "reason": connection.UNREACHABLE}


def test_a_hydrated_workspace_with_no_name_is_unreachable_rather_than_invalid(
    client, modal_fake: FakeModal
) -> None:
    """Blaming the pasted token for a shape the controller was not written
    against would send the user to mint a replacement that fails identically."""
    modal_fake.workspace_name = None

    response = client.post(PATH, headers=headers())

    assert response.json() == {"kind": "failed", "reason": connection.UNREACHABLE}


@pytest.mark.parametrize(
    "sent",
    [
        pytest.param(headers(controller_token=None), id="no bearer"),
        pytest.param(headers(controller_token="wrong-token"), id="wrong bearer"),
        pytest.param(headers(token_id=None), id="no caller token id"),
        pytest.param(headers(token_secret=None), id="no caller token secret"),
    ],
)
def test_the_endpoint_is_behind_the_same_two_credentials_as_every_other(
    client, sent: dict[str, str]
) -> None:
    """A credential test that anybody could call would be a free oracle for
    checking stolen Modal tokens, on OnCue's controller and OnCue's bill."""
    response = client.post(PATH, headers=sent)

    assert response.status_code == 401
    assert response.json()["category"] == "credentials"


def test_no_answer_carries_the_credential_under_test(client, modal_fake: FakeModal) -> None:
    """The endpoint that holds a token pair for longer than any other is the
    one that most needs this checked rather than assumed."""
    modal_fake.raise_on_list_environments = modal_exception.AuthError(CALLER_TOKEN_SECRET)
    refused = client.post(PATH, headers=headers()).text
    accepted = client.post(PATH, headers=headers(environment="main")).text

    for body in (refused, accepted):
        assert CALLER_TOKEN_ID not in body
        assert CALLER_TOKEN_SECRET not in body


def test_every_reason_the_controller_can_answer_with_is_in_the_closed_set() -> None:
    """The Worker's `worker/modal/client.ts` parses exactly these three and
    treats anything else as unreachable, so a fourth invented here would be
    silently flattened rather than acted on."""
    assert set(connection.REASONS) == {
        "invalid_credentials",
        "no_environment_access",
        "unreachable",
    }
