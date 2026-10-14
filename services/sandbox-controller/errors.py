"""Modal's exceptions translated into the driver's own categories.

Record 02 requires the control plane to see a stable category and a retryable
flag, not a provider-shaped error; this is the only module that names a Modal
exception class. Messages are fixed strings per category, never derived from
the exception's text, because a provider library may put the caller's
credential in an authentication failure's message.
"""

from __future__ import annotations

from dataclasses import dataclass

from modal import exception as modal_exception

# The union in `driver.ts`, transcribed. `test_errors.py` asserts every
# translation lands inside it.
CATEGORIES = (
    "capacity",
    "configuration",
    "image_preparation",
    "credentials",
    "repository_setup",
    "not_found",
    "conflict",
    "unknown",
)

# HTTP status per category. The driver reads the body's envelope, except that
# it treats 401 as a credential failure without parsing, so a controller that
# rejects us is never mistaken for one that answered.
STATUS_BY_CATEGORY = {
    "capacity": 503,
    "configuration": 400,
    "image_preparation": 500,
    "credentials": 401,
    "repository_setup": 500,
    "not_found": 404,
    "conflict": 409,
    "unknown": 500,
}


@dataclass(frozen=True)
class ControllerError(Exception):
    """A failure already translated into what the driver understands."""

    category: str
    message: str
    retryable: bool

    def envelope(self) -> dict[str, object]:
        return {
            "kind": "error",
            "category": self.category,
            "message": self.message,
            "retryable": self.retryable,
        }

    @property
    def status(self) -> int:
        return STATUS_BY_CATEGORY[self.category]


def error(category: str, message: str, *, retryable: bool) -> ControllerError:
    return ControllerError(category=category, message=message, retryable=retryable)


# Most specific first: `translate` returns the first matching row, and Modal
# has real subclasses (`ConflictError` under `InvalidError`, `ImageBuildError`
# under `RemoteError`, the exec and sandbox timeouts under `TimeoutError`). A
# subclass after its parent would be silently unreachable; `test_errors.py`
# checks the order.
_TRANSLATIONS: tuple[tuple[type[BaseException], str, str, bool], ...] = (
    (
        modal_exception.AuthError,
        "credentials",
        "Modal rejected the credential for this workspace.",
        False,
    ),
    (
        modal_exception.PermissionDeniedError,
        "credentials",
        "The Modal credential is not permitted to do this in this environment.",
        False,
    ),
    (
        modal_exception.AlreadyExistsError,
        "conflict",
        "A sandbox with this name already exists for this session.",
        False,
    ),
    (
        modal_exception.NotFoundError,
        "not_found",
        "Modal has no sandbox for this session and generation.",
        False,
    ),
    (
        modal_exception.ImageBuildError,
        "image_preparation",
        "The sandbox image did not build.",
        False,
    ),
    (
        modal_exception.ResourceExhaustedError,
        "capacity",
        "Modal has no capacity for this sandbox right now.",
        True,
    ),
    (
        # Before `InvalidError`, which it subclasses.
        modal_exception.ConflictError,
        "conflict",
        "Modal reported a conflicting change to this object.",
        False,
    ),
    (
        modal_exception.InvalidError,
        "configuration",
        "Modal refused the sandbox specification.",
        False,
    ),
    (
        # An exec past the caller's timeout would end the same way again, so it
        # is not retryable.
        modal_exception.ExecTimeoutError,
        "unknown",
        "A command in the sandbox ran past its timeout.",
        False,
    ),
    (
        # The sandbox hit its `timeout` ceiling and is gone, like any other
        # `not_found`; the session object replaces the generation.
        modal_exception.SandboxTimeoutError,
        "not_found",
        "This sandbox reached its lifetime limit and is no longer running.",
        False,
    ),
    (
        modal_exception.SandboxTerminatedError,
        "not_found",
        "This sandbox is no longer running.",
        False,
    ),
    (
        # The base timeout, after the specific ones. `snapshot_filesystem`
        # raises it after 55 seconds, and a retry is worthwhile.
        modal_exception.TimeoutError,
        "unknown",
        "The Modal call did not finish in time.",
        True,
    ),
    (
        modal_exception.ConnectionError,
        "unknown",
        "The controller could not reach Modal.",
        True,
    ),
    (
        modal_exception.RemoteError,
        "unknown",
        "Modal reported a server-side failure.",
        True,
    ),
)

_UNTRANSLATED = error(
    "unknown",
    "The controller met a failure it does not recognise.",
    retryable=False,
)


def translate(exc: BaseException) -> ControllerError:
    """Whatever was raised, expressed as one of the driver's categories."""
    if isinstance(exc, ControllerError):
        return exc
    for exception_type, category, message, retryable in _TRANSLATIONS:
        if isinstance(exc, exception_type):
            return error(category, message, retryable=retryable)
    return _UNTRANSLATED
