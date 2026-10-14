from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app as controller
from tests.fakes import CONTROLLER_TOKEN, FakeModal


@pytest.fixture
def modal_fake() -> FakeModal:
    return FakeModal()


@pytest.fixture
def client(modal_fake: FakeModal, monkeypatch: pytest.MonkeyPatch):
    """The real routes and dependency graph over a fake Modal; only `modal_api`
    is overridden."""
    monkeypatch.setenv(controller.CONTROLLER_TOKEN_ENV_KEY, CONTROLLER_TOKEN)
    controller.api.dependency_overrides[controller.modal_api] = modal_fake.api
    with TestClient(controller.api) as test_client:
        yield test_client
    controller.api.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def control_plane_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every sandbox spec needs the origin the bridge dials from the controller's
    environment. The test about its absence deletes it itself."""
    monkeypatch.setenv("ONCUE_CONTROL_PLANE_ORIGIN", "https://oncue.test")
