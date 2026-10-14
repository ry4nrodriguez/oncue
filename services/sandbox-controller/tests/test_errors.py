"""Every Modal exception the controller can meet, and the driver category it
becomes; `apps/web/worker/sandbox/driver.ts` owns the union (record 02)."""

from __future__ import annotations

import pytest
from modal import exception as modal_exception

from errors import _TRANSLATIONS, CATEGORIES, STATUS_BY_CATEGORY, ControllerError, translate
from tests.fakes import FakeModal, create_spec, headers


@pytest.mark.parametrize(
    ("raised", "category", "retryable"),
    [
        (modal_exception.AuthError("no"), "credentials", False),
        (modal_exception.PermissionDeniedError("no"), "credentials", False),
        (modal_exception.AlreadyExistsError("dup"), "conflict", False),
        (modal_exception.NotFoundError("gone"), "not_found", False),
        (modal_exception.ImageBuildError("bad", "im-1"), "image_preparation", False),
        (modal_exception.ResourceExhaustedError("full"), "capacity", True),
        (modal_exception.InvalidError("bad spec"), "configuration", False),
        # `ConflictError` SUBCLASSES `InvalidError`, so it has to be matched
        # first or a conflict is reported as a bad specification.
        (modal_exception.ConflictError("taken"), "conflict", False),
        # `snapshot_filesystem` raises the bare `TimeoutError` after 55
        # seconds; it is the controller's canonical retryable failure.
        (modal_exception.TimeoutError("slow"), "unknown", True),
        # Both subclass `TimeoutError` and neither is retryable: an exec past
        # its timeout will pass it again, and a timed-out sandbox is gone.
        (modal_exception.ExecTimeoutError("exec"), "unknown", False),
        (modal_exception.SandboxTimeoutError("life"), "not_found", False),
        (modal_exception.SandboxTerminatedError("gone"), "not_found", False),
        (modal_exception.ConnectionError("down"), "unknown", True),
        (modal_exception.RemoteError("boom"), "unknown", True),
        (ValueError("something else entirely"), "unknown", False),
    ],
)
def test_each_modal_exception_becomes_a_driver_category(
    raised: BaseException, category: str, retryable: bool
) -> None:
    translated = translate(raised)

    assert translated.category == category
    assert translated.retryable is retryable
    assert translated.category in CATEGORIES


def test_no_translation_is_shadowed_by_an_earlier_one() -> None:
    """`translate` returns the first matching row, and Modal's exceptions have
    real subclasses, so a subclass after its parent is silently unreachable.
    Checked structurally, so a misplaced new row fails here."""
    seen: list[type[BaseException]] = []
    for exception_type, _category, _message, _retryable in _TRANSLATIONS:
        for earlier in seen:
            assert not issubclass(exception_type, earlier), (
                f"{exception_type.__name__} is a subclass of {earlier.__name__} "
                "and is listed after it, so translate() can never reach it"
            )
        seen.append(exception_type)


def test_an_already_translated_error_passes_through_unchanged() -> None:
    original = ControllerError(category="capacity", message="no room", retryable=True)

    assert translate(original) is original


def test_every_category_has_a_status() -> None:
    assert set(STATUS_BY_CATEGORY) == set(CATEGORIES)


def test_no_message_is_derived_from_the_exceptions_own_text() -> None:
    """Provider libraries may put a credential in an authentication failure's
    message, so no message may be built from one."""
    secret = "as-a-token-secret-that-leaked-into-a-provider-message"

    for exception_type in (
        modal_exception.AuthError,
        modal_exception.RemoteError,
        modal_exception.InvalidError,
    ):
        translated = translate(exception_type(secret))
        assert secret not in translated.message


def test_a_modal_failure_reaches_the_driver_as_an_envelope(client, modal_fake: FakeModal) -> None:
    modal_fake.raise_on_create = modal_exception.ResourceExhaustedError("no capacity")

    response = client.post("/v1/create", json=create_spec(), headers=headers())

    assert response.status_code == 503
    assert response.json() == {
        "kind": "error",
        "category": "capacity",
        "message": "Modal has no capacity for this sandbox right now.",
        "retryable": True,
    }
