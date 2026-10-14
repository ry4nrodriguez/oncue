"""The wire shapes, mirroring `apps/web/worker/sandbox/driver.ts`, with its
camelCase field names since the driver is the only client."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Strict(BaseModel):
    # An unexpected field means the driver and controller disagree; fail on the
    # first request after a deploy rather than later.
    model_config = ConfigDict(extra="forbid")


class Reference(Strict):
    sessionId: str
    generation: int


class CreateSpec(Strict):
    sessionId: str
    generation: int
    imageReference: str
    resourceClass: str
    regionPreference: str | None
    expirationPolicy: str
    bootstrapCredential: str
    # An ISO-8601 instant after which the caller has stopped waiting. Optional
    # so a Worker deployed before it existed still creates.
    notAfter: str | None = None


class PrepareRequest(Strict):
    # How long to hold the request for a build already under way, capped by
    # the controller. Zero answers at once.
    waitMs: int = 0


class Command(Strict):
    commandLine: str
    timeoutMs: int


class ExecuteRequest(Strict):
    reference: Reference
    command: Command


class OutputRequest(Strict):
    reference: Reference
    # An ISO-8601 instant, or null for "from the sandbox's start". The answer
    # carries the instant to ask from next.
    since: str | None
