"""The sandbox controller: the provider half of the `SandboxDriver` boundary.

Workers cannot make outbound gRPC calls and Modal has no REST interface for
sandboxes, so record 02 splits the driver into a thin HTTPS client in the
Worker and this FastAPI application using the Python SDK. It is adapter code:
every product decision is made by the session object before it calls.

The controller holds no Modal credential. Each request carries the user's token
pair in headers, a `modal.Client` is built from it for that request, and the
token reaches `modal.Client.from_credentials` and nothing else: never logged,
echoed, put in an error, or written into a sandbox. The bearer controller
token says the caller is OnCue; the `x-oncue-modal-*` headers say which Modal
workspace to act in, and neither substitutes for the other. There is no
fallback to an ambient Modal client: that would create sandboxes in, and bill,
the operator's workspace instead of the user's.

Nothing about a sandbox is remembered between requests: `sandboxes.py`
recovers every answer from Modal, and the session object reconciles through
`getStatus`. The one exception is `prepare.py`'s memory of image builds, which
is a cache: losing it costs time, never correctness.

Every handler is a plain `def`, so FastAPI runs it on its thread pool. The
Modal SDK's calls block, and an `async def` handler making them would hold the
event loop and serve one request at a time.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

import connection
import images
import prepare
import sandboxes
from errors import ControllerError, error, translate
from models import CreateSpec, ExecuteRequest, OutputRequest, PrepareRequest, Reference

CONTROLLER_TOKEN_ENV_KEY = "ONCUE_CONTROLLER_TOKEN"

TOKEN_ID_HEADER = "x-oncue-modal-token-id"
TOKEN_SECRET_HEADER = "x-oncue-modal-token-secret"
ENVIRONMENT_HEADER = "x-oncue-modal-environment"

log = logging.getLogger("oncue.sandbox-controller")

api = FastAPI(title="OnCue sandbox controller")


@dataclass(frozen=True)
class Caller:
    """One request's Modal identity, already turned into a client.

    The token pair is not a field: it is consumed building `client`, so no
    handler or error path can reach it.
    """

    client: Any
    environment_name: str | None
    # Names the caller's Modal workspace and environment without carrying the
    # credential: a digest of the token pair and the environment, used only to
    # key `prepare.py`'s memory.
    workspace_key: str


# One per process: the builds it runs outlive the requests that start them.
preparer = prepare.Preparer()


def modal_api() -> sandboxes.ModalApi:
    """Overridden with fakes in `tests/`; the real thing in a deploy."""
    return sandboxes.default_api()


def controller_token() -> str | None:
    """Read per request, so a rotated Modal Secret takes effect immediately."""
    configured = os.environ.get(CONTROLLER_TOKEN_ENV_KEY)
    if configured is None:
        return None
    stripped = configured.strip()
    if stripped == "":
        return None
    return stripped


def _unauthenticated() -> ControllerError:
    # One message for every authentication failure, so an unauthenticated
    # caller cannot map the controller's configuration.
    return error(
        "credentials",
        "This request is not authenticated.",
        retryable=False,
    )


def check_controller_token(authorization: str | None) -> None:
    """Rejects the request unless it carries the configured controller token.

    Fails closed when no token is configured: the controller creates paid
    compute in a user's Modal workspace.
    """
    expected = controller_token()
    if expected is None:
        raise _unauthenticated()
    if authorization is None:
        raise _unauthenticated()
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise _unauthenticated()
    # `compare_digest` so an unauthenticated caller gets no timing oracle.
    if not hmac.compare_digest(authorization[len(prefix) :], expected):
        raise _unauthenticated()


def caller(
    api_deps: sandboxes.ModalApi = Depends(modal_api),
    authorization: str | None = Header(default=None),
    x_oncue_modal_token_id: str | None = Header(default=None),
    x_oncue_modal_token_secret: str | None = Header(default=None),
    x_oncue_modal_environment: str | None = Header(default=None),
) -> Caller:
    check_controller_token(authorization)
    if x_oncue_modal_token_id is None:
        raise _unauthenticated()
    if x_oncue_modal_token_secret is None:
        raise _unauthenticated()
    # Translated here because a FastAPI dependency runs before the handler's
    # `guarded`. An untranslated exception reaches Starlette, which logs a
    # traceback carrying `str(exc)`, and this is the one Modal call that
    # receives the raw token pair.
    try:
        client = api_deps.client_factory(x_oncue_modal_token_id, x_oncue_modal_token_secret)
    except BaseException as exc:  # noqa: BLE001 - re-raised as a translated ControllerError
        raise translate(exc) from None
    # The secret is part of the key too, so a pair that differs only in its
    # secret never reads another's memory. Hashed, never kept.
    workspace_key = hashlib.sha256(
        f"{x_oncue_modal_token_id}\0{x_oncue_modal_token_secret}\0"
        f"{x_oncue_modal_environment or ''}".encode()
    ).hexdigest()
    return Caller(
        client=client,
        environment_name=x_oncue_modal_environment,
        workspace_key=workspace_key,
    )


def ok(value: Any) -> JSONResponse:
    return JSONResponse({"kind": "ok", "value": value})


@api.exception_handler(ControllerError)
async def _controller_error_handler(_request: Request, exc: ControllerError) -> JSONResponse:
    return JSONResponse(exc.envelope(), status_code=exc.status)


@api.exception_handler(RequestValidationError)
async def _validation_handler(_request: Request, _exc: RequestValidationError) -> JSONResponse:
    # Pydantic's report echoes the invalid input, and a request body is where a
    # caller could misplace a credential, so the report is dropped.
    translated = error(
        "configuration",
        "The controller could not read this request.",
        retryable=False,
    )
    return JSONResponse(translated.envelope(), status_code=translated.status)


def guarded(operation: str, run: Callable[[], Any]) -> JSONResponse:
    """The one translation point, the twin of `attempt` in `driver.ts`.

    The log line carries the operation, category, and the translation's fixed
    sentence, never the exception's text. The sentence distinguishes the three
    credential failures (missing header, rejected pair, pair not permitted
    here), which the status alone cannot.
    """
    try:
        return ok(run())
    except BaseException as exc:  # noqa: BLE001 - translated, then re-raised as a ControllerError
        translated = translate(exc)
        log.warning(
            "operation=%s result=failed category=%s retryable=%s message=%r",
            operation,
            translated.category,
            translated.retryable,
            translated.message,
        )
        raise translated from None


@api.post("/v1/create")
def create(
    spec: CreateSpec,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    def run() -> dict[str, Any]:
        sandboxes.create(api_deps, context.client, spec, context.environment_name)
        return {"sessionId": spec.sessionId, "generation": spec.generation}

    return guarded("create", run)


@api.post("/v1/prepareImage")
def prepare_image(
    body: PrepareRequest,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    """Record 02's "Prepare": the image built in the caller's workspace.

    Answers `ready` with the image id create should name, or `building` when
    the build has not finished within `waitMs`. Idempotent, so the Worker
    calls it at Modal connect, after a release, and before every create.
    """

    def run() -> dict[str, Any]:
        return preparer.prepare(
            api_deps,
            context.client,
            context.environment_name,
            context.workspace_key,
            body.waitMs,
        )

    return guarded("prepareImage", run)


@api.post("/v1/start")
def start(
    reference: Reference,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    def run() -> dict[str, Any]:
        # Modal starts a sandbox when creating it. This confirms the generation
        # is running, so a create that never landed or a finished sandbox
        # shows up here.
        sandboxes.require(
            api_deps,
            context.client,
            reference.sessionId,
            reference.generation,
            context.environment_name,
        )
        return reference.model_dump()

    return guarded("start", run)


@api.post("/v1/stop")
def stop(
    reference: Reference,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    return guarded("stop", _terminator(api_deps, context, reference))


@api.post("/v1/destroy")
def destroy(
    reference: Reference,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    return guarded("destroy", _terminator(api_deps, context, reference))


def _terminator(
    api_deps: sandboxes.ModalApi, context: Caller, reference: Reference
) -> Callable[[], Any]:
    def run() -> dict[str, Any]:
        found = sandboxes.locate(
            api_deps,
            context.client,
            reference.sessionId,
            reference.generation,
            context.environment_name,
        )
        # Absent is success: a retried stop or destroy must converge.
        if found is not None:
            sandboxes.terminate(found)
        return reference.model_dump()

    return run


@api.post("/v1/getStatus")
def get_status(
    reference: Reference,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    """`active` while it runs, `stopped` or `failed` from the exit code once it
    has finished, and `not_found` only for a generation Modal never had."""

    def run() -> str:
        return sandboxes.status(
            api_deps,
            context.client,
            reference.sessionId,
            reference.generation,
            context.environment_name,
        )

    return guarded("getStatus", run)


@api.post("/v1/execute")
def execute(
    body: ExecuteRequest,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    def run() -> dict[str, Any]:
        found = sandboxes.require(
            api_deps,
            context.client,
            body.reference.sessionId,
            body.reference.generation,
            context.environment_name,
        )
        return {"executionId": sandboxes.execute(found, body.command)}

    return guarded("execute", run)


@api.post("/v1/getConnection")
def get_connection(
    reference: Reference,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    def run() -> dict[str, Any]:
        found = sandboxes.require(
            api_deps,
            context.client,
            reference.sessionId,
            reference.generation,
            context.environment_name,
        )
        # No bootstrap credential comes back: the controller keeps nothing, and
        # the Worker minted it.
        return {"bridgeUrl": sandboxes.connection_url(found)}

    return guarded("getConnection", run)


@api.post("/v1/getOutput")
def get_output(
    body: OutputRequest,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    """The sandbox's own output since a cursor, for the timeline to relay.

    Not one of record 02's eight driver operations: before the bridge's first
    frame, the entrypoint's stdout is the only thing that can say why a sandbox
    did not connect. The cursor travels with the request.
    """

    def run() -> dict[str, Any]:
        found = sandboxes.require(
            api_deps,
            context.client,
            body.reference.sessionId,
            body.reference.generation,
            context.environment_name,
        )
        return sandboxes.output(found, body.since)

    return guarded("getOutput", run)


@api.post("/v1/connection/test")
def test_connection(
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    """Tests the credential in the request headers; not a driver operation.

    It skips `guarded` and answers `connection.py`'s three named reasons inside
    a 200, because a settings screen asking about a pasted credential gets an
    answer, not a failed request. It takes no body, so the token has no second
    place to be logged.
    """
    return JSONResponse(connection.test_credential(api_deps, context.client))


@api.post("/v1/createCheckpoint")
def create_checkpoint(
    reference: Reference,
    context: Caller = Depends(caller),
    api_deps: sandboxes.ModalApi = Depends(modal_api),
) -> JSONResponse:
    def run() -> dict[str, Any]:
        found = sandboxes.require(
            api_deps,
            context.client,
            reference.sessionId,
            reference.generation,
            context.environment_name,
        )
        return {"checkpointId": sandboxes.checkpoint(found)}

    return guarded("createCheckpoint", run)


# ---------------------------------------------------------------------------
# The Modal deployment: `modal deploy app.py::controller_app` publishes the
# ASGI app at the `*.modal.run` origin the Worker's
# `ONCUE_SANDBOX_CONTROLLER_ORIGIN` holds. The `::controller_app` suffix is
# required, because the CLI otherwise looks for a variable named `app`. The
# controller runs in OnCue's own Modal workspace; every sandbox it creates
# lives in the calling user's workspace.
#
# `min_containers=1` keeps the controller's own start-up out of every
# session's cold start. `modal.concurrent` lets that one container serve
# requests side by side; without it Modal queues each request behind the last,
# and a create waits behind another workspace's image preparation.
# ---------------------------------------------------------------------------

import modal  # noqa: E402 - the deployment tail is separate from the app above

CONTROLLER_APP_NAME = "oncue-sandbox-controller"

# Requests one controller container serves at once. Below the 40 threads
# FastAPI's pool runs plain handlers on, so a request never queues for a
# thread after Modal admitted it.
CONCURRENT_REQUESTS = 32

controller_app = modal.App(CONTROLLER_APP_NAME)

# The bridge bundle is not a `.py` file, so `images.controller_image` must add
# it explicitly; `test_images.py` asserts it does.
controller_image = images.controller_image()


@controller_app.function(
    image=controller_image,
    min_containers=1,
    # The controller token only: every request carries the Modal credential to
    # act with.
    secrets=[modal.Secret.from_name("oncue-controller-token")],
)
@modal.concurrent(max_inputs=CONCURRENT_REQUESTS)
@modal.asgi_app()
def fastapi_app():
    return api
