"""`conformance.py` checked against the real SDK.

These tests read the installed `modal` package's shape (signatures and callable
kinds) and nothing else: no network, no credential, and no claim about Modal's
behaviour.
"""

from __future__ import annotations

import inspect
from typing import Any

import modal
import pytest
from modal import environments as modal_environments

from tests.conformance import conforming, return_kind


def test_the_argument_check_still_refuses_a_parameter_modal_does_not_have() -> None:
    """A fake's `**kwargs` would swallow `environment_name=` passed to
    `Sandbox.list`, which has no such parameter."""
    fake = conforming(modal.Sandbox.list, lambda **_kwargs: None)

    with pytest.raises(TypeError):
        fake(tags={"a": "b"}, environment_name="main")


def test_every_modal_entry_point_the_controller_uses_is_a_blocking_callable() -> None:
    """Modal's wrappers present a blocking callable with the async variant on
    `.aio`, so none of these is an async generator or coroutine function,
    whatever its return annotation says."""
    for real in (
        modal.Client.from_credentials,
        modal.App.lookup,
        modal.Sandbox.create,
        modal.Sandbox.from_name,
        modal.Sandbox.list,
        modal.Secret.from_dict,
        modal_environments.list_environments,
        modal.Workspace.from_context,
        modal.Workspace.hydrate,
        modal.Sandbox.poll,
        modal.Sandbox.terminate,
        modal.Sandbox.exec,
        modal.Sandbox.snapshot_filesystem,
    ):
        assert not inspect.isasyncgenfunction(real)
        assert not inspect.iscoroutinefunction(real)
        assert return_kind(real) == "a blocking callable"


def test_an_async_generator_fake_is_refused_for_a_blocking_modal_call() -> None:
    """An `async def ... yield` fake for `Sandbox.list` lets `async for` pass
    while every real call raises `TypeError`, because the real call returns a
    synchronous generator. Only the kind check catches that."""

    async def lying_fake(**_kwargs: Any):
        yield object()

    with pytest.raises(TypeError) as raised:
        conforming(modal.Sandbox.list, lying_fake)

    assert "async generator function" in str(raised.value)
    assert "Sandbox.list" in str(raised.value) or "list" in str(raised.value)


def test_a_coroutine_fake_is_refused_for_a_blocking_modal_call() -> None:
    """The mirror image, which is just as silent: `await`ing a fake that
    returns a coroutine works, and `await`ing Modal's blocking wrapper does
    not."""

    async def lying_fake(*_args: Any, **_kwargs: Any) -> None:
        return None

    with pytest.raises(TypeError):
        conforming(modal.Sandbox.from_name, lying_fake)


def test_a_blocking_fake_is_refused_where_the_real_call_is_a_coroutine() -> None:
    """And the reverse direction, so the rule is symmetric rather than a
    one-way ban on `async def` in this package."""

    async def real_async(value: int) -> int:
        return value

    with pytest.raises(TypeError):
        conforming(real_async, lambda value: value)

    # The matching kind is accepted, which is what makes the failures above
    # about the mismatch rather than about `conforming` refusing everything.
    assert conforming(real_async, real_async) is not None


def test_a_matching_blocking_fake_is_accepted() -> None:
    fake = conforming(modal.Sandbox.from_name, lambda _app, _name, **_kwargs: "sandbox")

    assert fake("oncue-sessions", "s-sess_1-g1") == "sandbox"
