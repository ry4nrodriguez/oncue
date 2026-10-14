"""Bind every faked Modal call to the real SDK signature and callable kind.

A fake written with `**kwargs: Any` accepts arguments the real function would
refuse, so a green suite could hide a controller that cannot make one real
call. `conforming` wraps a fake with `inspect.signature(real).bind(...)`, which
raises `TypeError` on an unknown name, a missing argument, or the wrong arity.
`modal` is pinned exactly, so an SDK upgrade that moves a parameter fails here.

It also compares callable kind (async generator, coroutine, or blocking), read
from the callable rather than its return annotation: Modal's blocking wrappers
carry the async implementation's annotation, and the async variant hangs off
`.aio`. So no fake for an entry point the controller uses may be `async def`.

It does not check behaviour: that names are unique among running sandboxes
only, and that a duplicate raises `AlreadyExistsError`, are imitated by
`fakes.py` (see `docs/history.md`).
"""

from __future__ import annotations

import inspect
from typing import Any, Callable


def _callable_signature(real: Callable[..., Any]) -> inspect.Signature:
    """The signature a caller has to satisfy, without a leading `cls` or `self`.

    Modal's wrappers are inconsistent: `Client.from_credentials` still shows
    `cls` while the others show no receiver.
    """
    signature = inspect.signature(real)
    parameters = list(signature.parameters.values())
    if parameters and parameters[0].name in ("cls", "self"):
        return signature.replace(parameters=parameters[1:])
    return signature


def return_kind(fn: Callable[..., Any]) -> str:
    """What calling `fn` returns: async generator, coroutine, or blocking.

    Read from the callable, not its return annotation, which Modal's blocking
    wrappers copy from the async implementation.
    """
    if inspect.isasyncgenfunction(fn):
        return "an async generator function"
    if inspect.iscoroutinefunction(fn):
        return "a coroutine function"
    return "a blocking callable"


def conforming(real: Callable[..., Any], fake: Callable[..., Any]) -> Callable[..., Any]:
    """A fake that refuses any call the real callable would refuse.

    Binding happens before the fake runs, because calling an async generator
    function runs none of its body. The kind check happens at wrap time, where
    the fake is paired with the real callable.
    """
    real_kind = return_kind(real)
    fake_kind = return_kind(fake)
    if real_kind != fake_kind:
        raise TypeError(
            f"{getattr(real, '__qualname__', real)} is {real_kind}, "
            f"so its fake must be too, but {getattr(fake, '__qualname__', fake)} "
            f"is {fake_kind}"
        )

    signature = _callable_signature(real)

    def checked(*args: Any, **kwargs: Any) -> Any:
        signature.bind(*args, **kwargs)
        return fake(*args, **kwargs)

    return checked
