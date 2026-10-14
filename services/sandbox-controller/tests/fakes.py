"""A fake Modal, standing in at `sandboxes.ModalApi`, so no unit test opens a
socket, holds a credential, or creates a paid resource. It imitates exactly the
two behaviours idempotency relies on: a name is unique among running sandboxes
only, and creating a duplicate raises `AlreadyExistsError`.
"""

from __future__ import annotations

import threading
from typing import Any

import modal
from modal import environments as modal_environments
from modal import exception as modal_exception

import sandboxes
from tests.conformance import conforming

CONTROLLER_TOKEN = "controller-token-for-tests"
CALLER_TOKEN_ID = "ak-caller-token-id"
CALLER_TOKEN_SECRET = "as-caller-token-secret"


class FakeImage:
    object_id = "im-snapshot"


class FakeBuiltImage:
    def __init__(self, object_id: str) -> None:
        self.object_id = object_id


class FakeImageDefinition:
    """What `images.base_image()` returns: a lazy image whose `build(app)`
    blocks until Modal has it. `gate`, when set, holds the build until a test
    releases it, so a test can see the `building` answer."""

    def __init__(self, fake: "FakeModal") -> None:
        self._fake = fake

    def build(self, app: Any) -> FakeBuiltImage:
        self._fake.builds.append(app)
        if self._fake.build_gate is not None:
            self._fake.build_gate.wait(timeout=10)
        if self._fake.raise_on_build is not None:
            raising, self._fake.raise_on_build = self._fake.raise_on_build, None
            raise raising
        return FakeBuiltImage(f"im-built-{self._fake.image_version_value}")


class FakeSandbox:
    def __init__(self, name: str, options: dict[str, Any]) -> None:
        self.object_id = f"sb-{name}"
        self.name = name
        self.options = options
        self.tags: dict[str, str] = dict(options.get("tags", {}))
        self.exit_code: int | None = None
        self.terminated = False
        self.execs: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        # What the entrypoint printed, as the SDK's log entries.
        self.printed: list[FakeLogEntry] = []

    def poll(self) -> int | None:
        return self.exit_code

    def terminate(self) -> None:
        # Two separate facts: `terminated` is running-set membership, which
        # `Sandbox.from_name` answers and which frees the name; `exit_code` is
        # what `poll()` answers.
        self.terminated = True
        self.exit_code = 0

    def exec(self, *args: Any, **kwargs: Any) -> Any:
        self.execs.append((args, kwargs))
        return object()

    def snapshot_filesystem(self) -> FakeImage:
        return FakeImage()

    @property
    def logs(self) -> "FakeLogs":
        return FakeLogs(self.printed)


class FakeLogEntry:
    """`modal.types.LogEntry`'s three fields the controller reads."""

    def __init__(self, message: str, timestamp: Any, source: str) -> None:
        self.message = message
        self.timestamp = timestamp
        self.source = source


class FakeLogs:
    """`Sandbox.logs`: `fetch(since=...)` is blocking and returns a plain
    iterable despite its `AsyncGenerator` annotation, so never `async def`."""

    def __init__(self, printed: list[FakeLogEntry]) -> None:
        self._printed = printed

    def fetch(self, *, since: Any, **_filters: Any) -> list[FakeLogEntry]:
        return [entry for entry in self._printed if entry.timestamp >= since]


class FakeClient:
    def __init__(self, token_id: str, token_secret: str) -> None:
        self.token_id = token_id
        self.token_secret = token_secret


class FakeEnvironment:
    """What `modal.environments.list_environments` yields; only `.name`, the
    field `connection.py` reads."""

    def __init__(self, name: str) -> None:
        self.name = name


class FakeWorkspace:
    """`.name` is `None` until `hydrate` runs, as in Modal, so removing the
    hydrate call fails the suite."""

    def __init__(self, name: str | None) -> None:
        self._name = name
        self.hydrated = False
        self.hydrate = conforming(modal.Workspace.hydrate, self._hydrate)

    def _hydrate(self, client: Any = None) -> "FakeWorkspace":
        self.hydrated = True
        return self

    @property
    def name(self) -> str | None:
        return self._name if self.hydrated else None


class FakeModal:
    """Every sandbox this fake workspace has ever held, running or not."""

    def __init__(self) -> None:
        self.sandboxes: list[FakeSandbox] = []
        self.apps_looked_up: list[tuple[str, str | None]] = []
        self.app_lookup_clients: list[Any] = []
        self.clients: list[FakeClient] = []
        self.create_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.raise_on_create: BaseException | None = None
        self.raise_on_from_name: BaseException | None = None
        # The credential test's fixtures: one named environment is a working
        # account; an empty list is the service-user default.
        self.environments: list[str] = ["main"]
        self.workspace_name: str | None = "acme-workspace"
        self.workspaces: list[FakeWorkspace] = []
        self.raise_on_list_environments: BaseException | None = None
        self.raise_on_workspace: BaseException | None = None
        # Image preparation: each `build` call's App, an optional gate that
        # holds builds, a one-shot failure, and the version `image_version`
        # reports.
        self.builds: list[Any] = []
        self.build_gate: threading.Event | None = None
        self.raise_on_build: BaseException | None = None
        self.image_version_value = "v1"
        self.images_from_id: list[str] = []

    # -- the ModalApi fields ------------------------------------------------

    def client_factory(self, token_id: str, token_secret: str) -> FakeClient:
        client = FakeClient(token_id, token_secret)
        self.clients.append(client)
        return client

    def app_lookup(self, name: str, **kwargs: Any) -> str:
        self.apps_looked_up.append((name, kwargs.get("environment_name")))
        self.app_lookup_clients.append(kwargs.get("client"))
        return f"app:{name}"

    def sandbox_create(self, *args: Any, **kwargs: Any) -> FakeSandbox:
        self.create_calls.append((args, kwargs))
        if self.raise_on_create is not None:
            raising, self.raise_on_create = self.raise_on_create, None
            raise raising
        name = kwargs["name"]
        if self._running(name) is not None:
            raise modal_exception.AlreadyExistsError(name)
        sandbox = FakeSandbox(name, kwargs)
        self.sandboxes.append(sandbox)
        return sandbox

    def sandbox_from_name(self, _app_name: str, name: str, **_kwargs: Any) -> FakeSandbox:
        if self.raise_on_from_name is not None:
            raising, self.raise_on_from_name = self.raise_on_from_name, None
            raise raising
        found = self._running(name)
        if found is None:
            raise modal_exception.NotFoundError(name)
        return found

    def list_environments(self, client: Any = None) -> list[FakeEnvironment]:
        if self.raise_on_list_environments is not None:
            raising, self.raise_on_list_environments = self.raise_on_list_environments, None
            raise raising
        return [FakeEnvironment(name) for name in self.environments]

    def workspace_from_context(self, client: Any = None) -> FakeWorkspace:
        if self.raise_on_workspace is not None:
            raising, self.raise_on_workspace = self.raise_on_workspace, None
            raise raising
        workspace = FakeWorkspace(self.workspace_name)
        self.workspaces.append(workspace)
        return workspace

    def secret_from_dict(self, values: dict[str, str]) -> dict[str, str]:
        return dict(values)

    def image_factory(self) -> FakeImageDefinition:
        return FakeImageDefinition(self)

    def image_version(self) -> str:
        return self.image_version_value

    def image_from_id(self, image_id: str, client: Any = None) -> str:
        self.images_from_id.append(image_id)
        return f"image:{image_id}"

    def list_generation(
        self, _app: Any, session_id: str, generation: int, client: Any = None
    ) -> list[sandboxes.GenerationRecord]:
        """Running and finished alike, as `SandboxList` with
        `include_finished=True` answers; filtered by the generation's tags."""
        wanted = sandboxes.sandbox_tags(session_id, generation)
        return [
            sandboxes.GenerationRecord(
                name=sandbox.name,
                exit_code=sandbox.exit_code,
            )
            for sandbox in self.sandboxes
            if all(sandbox.tags.get(name) == value for name, value in wanted.items())
        ]

    # -- helpers ------------------------------------------------------------

    def _running(self, name: str) -> FakeSandbox | None:
        for sandbox in self.sandboxes:
            if sandbox.name == name and not sandbox.terminated:
                return sandbox
        return None

    def api(self) -> sandboxes.ModalApi:
        """The seam, with each fake bound to the real signature it stands for,
        mirroring `default_api()`. `image_factory` is OnCue's own function, and
        `Workspace.hydrate` is conformed on `FakeWorkspace` instead."""
        return sandboxes.ModalApi(
            client_factory=conforming(modal.Client.from_credentials, self.client_factory),
            app_lookup=conforming(modal.App.lookup, self.app_lookup),
            sandbox_create=conforming(modal.Sandbox.create, self.sandbox_create),
            sandbox_from_name=conforming(modal.Sandbox.from_name, self.sandbox_from_name),
            secret_from_dict=conforming(modal.Secret.from_dict, self.secret_from_dict),
            image_factory=self.image_factory,
            image_version=self.image_version,
            image_from_id=conforming(modal.Image.from_id, self.image_from_id),
            list_generation=conforming(
                sandboxes._list_generation_blocking(), self.list_generation
            ),
            list_environments=conforming(
                modal_environments.list_environments, self.list_environments
            ),
            workspace_from_context=conforming(
                modal.Workspace.from_context, self.workspace_from_context
            ),
        )


def create_spec(session_id: str = "sess_1", generation: int = 1) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "generation": generation,
        "imageReference": "oncue-base:1",
        "resourceClass": "standard",
        "regionPreference": None,
        "expirationPolicy": "idle_20m",
        "bootstrapCredential": "boot_sess_1_1",
    }


def headers(
    *,
    controller_token: str | None = CONTROLLER_TOKEN,
    token_id: str | None = CALLER_TOKEN_ID,
    token_secret: str | None = CALLER_TOKEN_SECRET,
    environment: str | None = None,
) -> dict[str, str]:
    sent: dict[str, str] = {}
    if controller_token is not None:
        sent["authorization"] = f"Bearer {controller_token}"
    if token_id is not None:
        sent["x-oncue-modal-token-id"] = token_id
    if token_secret is not None:
        sent["x-oncue-modal-token-secret"] = token_secret
    if environment is not None:
        sent["x-oncue-modal-environment"] = environment
    return sent
