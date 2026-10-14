"""Building the sandbox image in a caller's Modal workspace ahead of create.

Modal caches an image per workspace, and every user's sandboxes run in their
own workspace, so the first session after any image change would otherwise
build the image inside its own `Sandbox.create`, for minutes. Preparation
builds it separately and hands back the image id, which create then names, so
a create never waits on a build.

A build outlives the request that started it. It runs on a small thread pool,
and each request waits for it at most `MAX_WAIT_MS` before answering
`building`, so no HTTP request is held open for minutes; the caller asks again
until it hears `ready`. The pool, the builds under way, and the ids of images
already prepared are this process's only memory. Losing it costs time and
nothing else: Modal keeps every layer it finished, so a build started again
resumes from them, and two builds of one image in one workspace, from two
processes, end in the same image.

A build holds the caller's Modal client until it finishes. That is the one
place the controller keeps a credential past its request, and only in memory.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any

import sandboxes

# Below the Worker's per-request deadline for this call, with room for the
# round trip.
MAX_WAIT_MS = 25_000

# Builds run concurrently up to this; more queue behind them. After a release
# every workspace's warm arrives at once, and a build mostly waits on Modal,
# so the pool is wide.
BUILD_WORKERS = 16

# A build still running after this is forgotten, and the next request starts
# another. A Python thread cannot be stopped, so a hung build keeps its
# worker; this keeps it from holding the workspace's preparation as well. The
# time counts from when the build began to run, not from when it was queued:
# a build waiting for a worker is not hung, and starting it again would only
# queue a duplicate behind it.
BUILD_FORGET_AFTER_S = 20 * 60

# Prepared image ids remembered per (workspace, image version), least
# recently used first out.
REMEMBERED_IMAGES = 512


class _Clock:
    """When a build began to run on a worker; `None` while it waits for one."""

    def __init__(self) -> None:
        self.began: float | None = None

    def running_for(self) -> float:
        return 0.0 if self.began is None else monotonic() - self.began


class Preparer:
    def __init__(self, workers: int = BUILD_WORKERS, remembered: int = REMEMBERED_IMAGES) -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="oncue-image")
        self._lock = threading.Lock()
        self._ready: OrderedDict[tuple[str, str], str] = OrderedDict()
        # Each build under way and the clock its worker starts.
        self._building: dict[tuple[str, str], tuple[Future[str], _Clock]] = {}
        self._remembered = remembered

    def prepare(
        self,
        api: sandboxes.ModalApi,
        client: Any,
        environment_name: str | None,
        workspace_key: str,
        wait_ms: int,
    ) -> dict[str, Any]:
        """`ready` with the image id, or `building`. Idempotent: a call while a
        build is under way joins it, and one after it finished is answered
        from memory."""
        version = api.image_version()
        key = (workspace_key, version)
        started = False
        with self._lock:
            image_id = self._ready.get(key)
            if image_id is not None:
                self._ready.move_to_end(key)
                return _ready(image_id, version)
            entry = self._building.get(key)
            future = None if entry is None else entry[0]
            # A failed build whose callback has not yet run is as good as
            # forgotten: its waiter already has the failure. So is one that
            # has run past `BUILD_FORGET_AFTER_S`.
            if (
                future is None
                or (future.done() and future.exception() is not None)
                or (not future.done() and entry[1].running_for() > BUILD_FORGET_AFTER_S)
            ):
                clock = _Clock()
                future = self._executor.submit(_build, clock, api, client, environment_name)
                self._building[key] = (future, clock)
                started = True
        if started:
            # Outside the lock: a build that already finished runs the
            # callback here, at once, and the callback takes the lock.
            future.add_done_callback(lambda done: self._settle(key, done))
        try:
            image_id = future.result(timeout=max(0, min(wait_ms, MAX_WAIT_MS)) / 1000)
        except FutureTimeoutError:
            # The wait running out and a build that itself raised a timeout
            # are one exception class. Only a build still running is
            # `building`; a finished one gives its own result or failure.
            if not future.done():
                return {"state": "building", "imageVersion": version}
            image_id = future.result()
        return _ready(image_id, version)

    def _settle(self, key: tuple[str, str], done: Future[str]) -> None:
        # A failed build is forgotten, so the next request starts it again;
        # its own waiter, if any, receives the failure from `result()`.
        with self._lock:
            entry = self._building.get(key)
            if entry is not None and entry[0] is done:
                del self._building[key]
            if done.exception() is not None:
                return
            self._ready[key] = done.result()
            self._ready.move_to_end(key)
            while len(self._ready) > self._remembered:
                self._ready.popitem(last=False)


def monotonic() -> float:
    """The build watchdog's clock; tests replace it."""
    return time.monotonic()


def _ready(image_id: str, version: str) -> dict[str, Any]:
    return {"state": "ready", "imageReference": image_id, "imageVersion": version}


def _build(
    clock: _Clock, api: sandboxes.ModalApi, client: Any, environment_name: str | None
) -> str:
    """Builds, or finds already built, the base image in the caller's
    workspace. `Image.build` takes its client from the App, which was looked
    up with the caller's client."""
    clock.began = monotonic()
    app = sandboxes.ensure_app(api, client, environment_name)
    return api.image_factory().build(app).object_id
