"""Sandbox identity, idempotent creation, and reconciliation through Modal.

Record 02 requires the controller to hold no state of its own and to make
create idempotent on `(sessionId, generation)`. Every answer is recovered from
Modal on the request that needs it.

Modal has no create-or-get, so create looks up, creates, and on
`AlreadyExistsError` looks up again; the last step tells a losing retry about
the winner's sandbox.

`Sandbox.from_name` finds only running sandboxes, and `Sandbox.list`
hard-codes `include_finished=False`. The `SandboxList` call underneath takes
`include_finished=True` with a tag filter and then answers with finished
sandboxes too, each with its name and exit code (observed live). So a
generation that ran and exited is still visible: `create` refuses to start a
second sandbox for it, and `getStatus` reports it `stopped` or `failed`
instead of `not_found`.
"""

from __future__ import annotations

import functools
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from modal import exception as modal_exception
from modal.stream_type import StreamType

from errors import error
from images import BOOTSTRAP_ENV_KEY, entrypoint_command, sandbox_options
from models import Command, CreateSpec

# What the Worker sends as `imageReference` when it has prepared the image:
# a Modal image id. Anything else is an older Worker that never prepared one,
# and create builds the image itself as it always did.
IMAGE_ID_PREFIX = "im-"

# One App per user workspace, created on first use. `Sandbox.from_name` needs
# a deployed App, which `App.lookup(create_if_missing=True)` provides.
APP_NAME = "oncue-sessions"

# Modal caps a sandbox name at 64 characters. Truncation keeps the generation
# suffix, so two generations of one session never share a name.
MAX_NAME_LENGTH = 64

# Written at create and never read back: Modal's only tag search is
# running-only and ignores the caller's environment. The tags let a person
# find a session's sandbox in Modal's dashboard.
SESSION_TAG = "oncue_session"
GENERATION_TAG = "oncue_generation"


@dataclass(frozen=True)
class GenerationRecord:
    """One sandbox Modal holds or held under a generation's tags."""

    name: str
    # `None` while it runs; its exit code once it has finished.
    exit_code: int | None


@dataclass(frozen=True)
class ModalApi:
    """The seam the unit tests replace: every Modal entry point the controller
    uses. `default_api()` is the only function that reads the `modal` module."""

    client_factory: Callable[..., Any]
    app_lookup: Callable[..., Any]
    sandbox_create: Callable[..., Any]
    sandbox_from_name: Callable[..., Any]
    secret_from_dict: Callable[..., Any]
    image_factory: Callable[..., Any]
    # A digest of what the image is built from, so a prepared image can be
    # recognised as current without building anything.
    image_version: Callable[[], str]
    image_from_id: Callable[..., Any]
    # Every sandbox, running or finished, carrying a generation's tags: the
    # one lookup that sees a sandbox after it exits.
    list_generation: Callable[..., list[GenerationRecord]]
    # The two `connection.py` uses, kept here so `default_api()` stays the only
    # place that reads the `modal` module.
    list_environments: Callable[..., Any]
    workspace_from_context: Callable[..., Any]


@functools.cache
def default_api() -> ModalApi:
    """Built once per process: every field is a stateless entry point."""
    import modal
    from modal import environments as modal_environments

    from images import base_image, image_version

    return ModalApi(
        client_factory=modal.Client.from_credentials,
        app_lookup=modal.App.lookup,
        sandbox_create=modal.Sandbox.create,
        sandbox_from_name=modal.Sandbox.from_name,
        secret_from_dict=modal.Secret.from_dict,
        image_factory=base_image,
        image_version=image_version,
        image_from_id=modal.Image.from_id,
        list_generation=_list_generation_blocking(),
        list_environments=modal_environments.list_environments,
        workspace_from_context=modal.Workspace.from_context,
    )


def _list_generation_blocking() -> Callable[..., list[GenerationRecord]]:
    """`SandboxList` with `include_finished=True`, which the SDK's own
    `Sandbox.list` never sends. Wrapped by Modal's synchronizer so a blocking
    caller can use it like any other SDK call; the client argument arrives
    already translated to the SDK's internal client."""
    from modal._utils.async_utils import synchronize_api
    from modal_proto import api_pb2

    async def _list_generation(
        app: Any, session_id: str, generation: int, client: Any
    ) -> list[GenerationRecord]:
        tags = [
            api_pb2.SandboxTag(tag_name=name, tag_value=value)
            for name, value in sandbox_tags(session_id, generation).items()
        ]
        response = await client.stub.SandboxList(
            api_pb2.SandboxListRequest(app_id=app.app_id, include_finished=True, tags=tags)
        )
        return [
            GenerationRecord(
                name=info.name,
                exit_code=info.task_info.result.exitcode if info.task_info.finished_at else None,
            )
            for info in response.sandboxes
        ]

    return synchronize_api(_list_generation)


def sandbox_name(session_id: str, generation: int) -> str:
    suffix = f"-g{generation}"
    return f"s-{session_id}"[: MAX_NAME_LENGTH - len(suffix)] + suffix


def sandbox_tags(session_id: str, generation: int) -> dict[str, str]:
    return {SESSION_TAG: session_id, GENERATION_TAG: str(generation)}


def ensure_app(api: ModalApi, client: Any, environment_name: str | None) -> Any:
    return api.app_lookup(
        APP_NAME,
        client=client,
        environment_name=environment_name,
        create_if_missing=True,
    )


def find_running(
    api: ModalApi, client: Any, name: str, environment_name: str | None
) -> Any | None:
    try:
        return api.sandbox_from_name(
            APP_NAME, name, client=client, environment_name=environment_name
        )
    except modal_exception.NotFoundError:
        return None


def locate(
    api: ModalApi,
    client: Any,
    session_id: str,
    generation: int,
    environment_name: str | None,
) -> Any | None:
    """The only lookup, by the deterministic sandbox name.

    Not `async`: every Modal entry point used here is a blocking callable.
    """
    return find_running(api, client, sandbox_name(session_id, generation), environment_name)


def require(
    api: ModalApi,
    client: Any,
    session_id: str,
    generation: int,
    environment_name: str | None,
) -> Any:
    found = locate(api, client, session_id, generation, environment_name)
    if found is None:
        raise error(
            "not_found",
            "Modal has no sandbox for this session and generation.",
            retryable=False,
        )
    return found


def find_finished(
    api: ModalApi,
    client: Any,
    app: Any,
    session_id: str,
    generation: int,
) -> GenerationRecord | None:
    """The generation's sandbox if it ran and has exited, else `None`.

    Matched on the name as well as the tags, because the tags are only a
    filter and a person could tag something else the same way.
    """
    name = sandbox_name(session_id, generation)
    for record in api.list_generation(app, session_id, generation, client=client):
        if record.name == name and record.exit_code is not None:
            return record
    return None


def clock() -> datetime:
    """The controller's clock; tests replace it to move time across a create."""
    return datetime.now(timezone.utc)


def _parse_instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def create(
    api: ModalApi,
    client: Any,
    spec: CreateSpec,
    environment_name: str | None,
) -> Any:
    """Look up, create, and on a lost race look up again.

    Two refusals keep a retried create from ever producing a second sandbox
    for one generation: a generation whose sandbox already ran and exited is a
    conflict, and nothing is started once the caller's `notAfter` has passed,
    since the caller has stopped waiting and would not know the sandbox exists.
    A sandbox Modal finishes creating after `notAfter` is stopped at once.
    """
    name = sandbox_name(spec.sessionId, spec.generation)
    existing = find_running(api, client, name, environment_name)
    if existing is not None:
        return existing

    app = ensure_app(api, client, environment_name)
    if find_finished(api, client, app, spec.sessionId, spec.generation) is not None:
        raise error(
            "conflict",
            "This generation's sandbox already ran and exited; a new generation is needed.",
            retryable=False,
        )
    if spec.notAfter is not None and clock() > _parse_instant(spec.notAfter):
        raise error(
            "unknown",
            "The caller had stopped waiting for this create, so no sandbox was started.",
            retryable=True,
        )
    if spec.imageReference.startswith(IMAGE_ID_PREFIX):
        image = api.image_from_id(spec.imageReference, client=client)
    else:
        image = api.image_factory()
    options = sandbox_options(
        spec,
        image=image,
        app=app,
        name=name,
        tags=sandbox_tags(spec.sessionId, spec.generation),
        secrets=[api.secret_from_dict(bootstrap_secret(spec))],
    )
    try:
        # No `environment_name`: it is deprecated and ignored on
        # `Sandbox.create` in 1.5.5, since a sandbox takes its environment from
        # its App (`ensure_app`).
        created = api.sandbox_create(
            *entrypoint_command(),
            client=client,
            **options,
        )
    except modal_exception.AlreadyExistsError:
        # A concurrent or retried create won the race; returning the winner's
        # sandbox keeps create idempotent.
        raced = find_running(api, client, name, environment_name)
        if raced is None:
            raise
        return raced
    # Checked again once Modal answered: a create sent just before the
    # deadline can land after it, when the caller has stopped waiting and its
    # stop sweep may already have looked. Only this request's own sandbox is
    # stopped, never one a concurrent create made.
    if spec.notAfter is not None and clock() > _parse_instant(spec.notAfter):
        terminate(created)
        raise error(
            "unknown",
            "The sandbox started after the caller had stopped waiting, so it was stopped.",
            retryable=False,
        )
    return created


def status(
    api: ModalApi,
    client: Any,
    session_id: str,
    generation: int,
    environment_name: str | None,
) -> str:
    """A generation's `SandboxState`: from the running sandbox, or from the
    exit code of one that finished; `not_found` only when Modal never had it."""
    running = locate(api, client, session_id, generation, environment_name)
    if running is not None:
        return state_of(running)
    app = ensure_app(api, client, environment_name)
    finished = find_finished(api, client, app, session_id, generation)
    if finished is None:
        raise error(
            "not_found",
            "Modal has no sandbox for this session and generation.",
            retryable=False,
        )
    return state_from_exit(finished.exit_code)


def bootstrap_secret(spec: CreateSpec) -> dict[str, str]:
    return {BOOTSTRAP_ENV_KEY: spec.bootstrapCredential}


def state_of(sandbox: Any) -> str:
    """A Modal sandbox's liveness as a `SandboxState`.

    `poll()` is `None` while running and the exit code after. The session
    object decides every other state in record 11's machine.
    """
    return state_from_exit(sandbox.poll())


def state_from_exit(code: int | None) -> str:
    if code is None:
        return "active"
    if code in (0, SIGKILL_EXIT):
        return "stopped"
    return "failed"


# Modal's terminate sends SIGKILL, so `poll()` returns 137 after it. A sandbox
# OnCue stopped on purpose is `stopped`; any other non-zero code is `failed`.
SIGKILL_EXIT = 137


def terminate(sandbox: Any) -> None:
    """Both `stop` and `destroy` land here.

    Modal offers only termination; the two operations differ in what the
    control plane does around them. Neither raises when the sandbox is already
    gone, so a retry converges.
    """
    sandbox.terminate()


def execution_id(sandbox: Any) -> str:
    """An opaque handle for one `execute` call.

    The SDK's process handle has no public stable id in 1.5.5, so this pairs the
    sandbox's object id with a random suffix.
    """
    return f"{sandbox.object_id}-{uuid.uuid4().hex}"


def execute(sandbox: Any, command: Command) -> str:
    """Fire and forget, with both streams discarded.

    Modal defaults both streams to pipes, and an unread pipe fills and stalls
    the command. Output reaches the timeline through the bridge instead.

    `env` unsets the bootstrap credential: Modal injects a Secret into the
    container's base environment, and every `Sandbox.exec` process inherits it
    whatever user it runs as. Record 02 already forbids running agent commands
    or injecting credentials here; this keeps the operation from leaking even
    if that rule is broken.
    """
    sandbox.exec(
        "/bin/sh",
        "-c",
        command.commandLine,
        env={BOOTSTRAP_ENV_KEY: None},
        stdout=StreamType.DEVNULL,
        stderr=StreamType.DEVNULL,
        timeout=max(1, command.timeoutMs // 1000),
    )
    return execution_id(sandbox)


def connection_url(sandbox: Any) -> str:
    """A stable name for this sandbox in logs, not a socket to dial.

    The bridge connects outbound to the session object and the controller is
    not on the event path (record 02), so there is no inbound port to return.
    """
    return f"modal://{APP_NAME}/{sandbox.object_id}"


def checkpoint(sandbox: Any) -> str:
    return sandbox.snapshot_filesystem().object_id


# How far back the first output request looks; polling starts at create.
FIRST_OUTPUT_WINDOW = timedelta(hours=1)


def parse_since(value: str | None, now: datetime) -> datetime:
    """The caller's cursor as a UTC instant, or the window's start."""
    if value is None:
        return now - FIRST_OUTPUT_WINDOW
    return _parse_instant(value).astimezone(timezone.utc)


def output(sandbox: Any, since: str | None, now: datetime | None = None) -> dict[str, Any]:
    """What the sandbox's entrypoint has printed since `since`.

    `Sandbox.logs.fetch` is blocking despite its `AsyncGenerator` annotation,
    so it is iterated with a plain `for`. It excludes `exec` output.

    `next` is one microsecond past the last line, so no line repeats; with
    nothing new it stays at `since`. Modal surfaces a line seconds after it is
    printed, stamped with the print time, so jumping to "now" on an empty poll
    would skip lines still in flight.
    """
    current = datetime.now(timezone.utc) if now is None else now
    start = parse_since(since, current)
    lines: list[dict[str, str]] = []
    latest = start
    for entry in sandbox.logs.fetch(since=start):
        stamp = entry.timestamp
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        text = entry.message.rstrip("\n")
        if text == "":
            continue
        lines.append({"stream": entry.source, "at": stamp.isoformat(), "text": text})
        if stamp > latest:
            latest = stamp
    following = (latest + timedelta(microseconds=1)) if lines else start
    return {"lines": lines, "next": following.isoformat()}
