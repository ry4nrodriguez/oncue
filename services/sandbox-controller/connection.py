"""Testing a user's Modal credential, which is not a driver operation.

It creates nothing and names no session, so it lives outside the driver's
eight operations and answers at `/v1/connection/test`. Each stage can fail on
its own:

1. `list_environments` is the first call the credential must satisfy; an
   unrecognised pair fails here.
2. An empty environment list means a service user with no access to any
   environment: a genuine credential with a different fix, so it is reported
   separately.
3. `Workspace.from_context`, `.hydrate`, then `.name` gives the workspace name
   the user confirms. `.name` is `None` before hydration.

No message is derived from an exception's text, for the reason `errors.py`
gives.
"""

from __future__ import annotations

from typing import Any

from modal import exception as modal_exception

# The reasons `worker/modal/client.ts` knows; the two lists are one closed set.
INVALID_CREDENTIALS = "invalid_credentials"
NO_ENVIRONMENT_ACCESS = "no_environment_access"
UNREACHABLE = "unreachable"

REASONS = (INVALID_CREDENTIALS, NO_ENVIRONMENT_ACCESS, UNREACHABLE)


class _Failed(Exception):
    """A stage decided the answer itself rather than raising out of Modal."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _probe(api: Any, client: Any) -> dict[str, Any]:
    environments = [item.name for item in api.list_environments(client=client)]
    if not environments:
        raise _Failed(NO_ENVIRONMENT_ACCESS)

    workspace = api.workspace_from_context(client=client)
    workspace.hydrate(client=client)
    name = workspace.name
    # A hydrated workspace with no name means an SDK shape this controller does
    # not know; it is neither a usable answer nor the user's fault.
    if not isinstance(name, str) or name == "":
        raise _Failed(UNREACHABLE)

    return {"workspaceName": name, "environments": environments}


def test_credential(api: Any, client: Any) -> dict[str, Any]:
    """The whole test, as one envelope. Never raises.

    A credential that will not work is a successful request, so the failure is
    a value in a 200; the error envelope is for the controller refusing the
    caller. `PermissionDeniedError` means Modal accepted the credential but
    refused the action, the service-user default, so it maps to
    `no_environment_access`.
    """
    try:
        return {"kind": "ok", "value": _probe(api, client)}
    except _Failed as failed:
        return {"kind": "failed", "reason": failed.reason}
    except modal_exception.AuthError:
        return {"kind": "failed", "reason": INVALID_CREDENTIALS}
    except modal_exception.PermissionDeniedError:
        return {"kind": "failed", "reason": NO_ENVIRONMENT_ACCESS}
    except BaseException:  # noqa: BLE001 - every remaining failure is "we could not find out"
        # Any other failure leaves the credential's status unknown, so the only
        # answer is to try again. The exception is dropped, as the module
        # docstring explains.
        return {"kind": "failed", "reason": UNREACHABLE}
