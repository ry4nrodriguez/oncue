"""The sandbox specification, asserted directly rather than through a deploy.

A wrong network policy or Unix-user boundary would weaken isolation silently,
since the sandbox would still start and run the agent."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import images
from errors import ControllerError
from models import CreateSpec
from tests.fakes import FakeModal, create_spec, headers


def spec(**overrides) -> CreateSpec:
    return CreateSpec(**{**create_spec(), **overrides})


def bundle(tmp_path, name: str, content: str = "console.log('bundle')") -> str:
    """A throwaway bundle file, standing in for whatever
    `services/bridge/build.ts` would have produced."""
    path = tmp_path / name
    path.write_text(content)
    return str(path)


def image_bundles(tmp_path) -> tuple[str, str]:
    """A (bridge, supervisor) pair of present bundle files, for tests that
    need `base_image` to get past bundle resolution entirely. The runtime host
    is found beside the supervisor bundle, so it is written there too."""
    bundle(tmp_path, "runtime-host.mjs")
    return bundle(tmp_path, "bridge.mjs"), bundle(tmp_path, "supervisor.mjs")


def options(**overrides) -> dict:
    return images.sandbox_options(
        spec(**overrides),
        image="image:base",
        app="app:oncue-sessions",
        name="s-sess_1-g1",
        tags={"oncue_session": "sess_1", "oncue_generation": "1"},
        secrets=[],
    )


def test_the_network_policy_is_a_domain_allowlist_and_nothing_else() -> None:
    """`outbound_cidr_allowlist=["0.0.0.0/0"]` would permit every protocol to
    every address, including the metadata endpoint (record 09)."""
    assert images.NETWORK_POLICY == {"outbound_domain_allowlist": ["*"]}

    built = options()
    assert built["outbound_domain_allowlist"] == ["*"]
    assert "outbound_cidr_allowlist" not in built
    assert "cidr_allowlist" not in built
    # `block_network=True` cannot be combined with an allowlist, so it is not
    # passed at all rather than passed as False.
    assert "block_network" not in built


def test_the_sandbox_runs_the_bridge_entrypoint_not_the_agent() -> None:
    assert images.entrypoint_command() == ["/bin/sh", "/opt/oncue/entrypoint.sh"]


def test_the_entrypoint_hands_off_to_the_supervisor_as_root() -> None:
    """The entrypoint stays root and hands off to `tini`, which execs the
    supervisor; the supervisor alone reads the bootstrap credential and drops
    it from its environment before spawning anything (record 02)."""
    script = images.ENTRYPOINT_SCRIPT

    assert f"exec tini -s -- node {images.SUPERVISOR_BUNDLE_PATH}" in script
    assert "setpriv" not in script
    assert str(images.AGENT_UID) not in script.split("exec ")[1]


def test_the_entrypoint_no_longer_touches_the_bootstrap_credential() -> None:
    """The entrypoint script must not reference the bootstrap file or its env
    key; that belongs to the supervisor."""
    script = images.ENTRYPOINT_SCRIPT

    assert images.BOOTSTRAP_ENV_KEY not in script
    assert images.BOOTSTRAP_FILE_PATH not in script


def test_the_bridge_and_the_agent_are_different_unix_users() -> None:
    assert images.BRIDGE_UID != images.AGENT_UID


def test_the_agents_working_tree_is_the_workdir() -> None:
    assert options()["workdir"] == images.AGENT_WORKDIR


def test_an_idle_sandbox_stops_after_about_twenty_minutes() -> None:
    built = options()

    # Modal's idle timer never resets for a sandbox nothing is exec'd into, so
    # the object's alarm owns idleness and Modal's `timeout` is the backstop.
    assert built["idle_timeout"] is None
    assert built["timeout"] == 86_400


def test_a_region_preference_is_passed_only_when_there_is_one() -> None:
    assert "region" not in options()
    assert options(regionPreference="us-east")["region"] == "us-east"


@pytest.mark.parametrize(
    ("field", "value"),
    [("resourceClass", "enormous"), ("expirationPolicy", "never")],
)
def test_an_unknown_class_or_policy_is_a_configuration_failure(field: str, value: str) -> None:
    with pytest.raises(ControllerError) as raised:
        options(**{field: value})

    assert raised.value.category == "configuration"


def test_the_bootstrap_credential_reaches_the_sandbox_as_a_secret(
    client, modal_fake: FakeModal
) -> None:
    client.post("/v1/create", json=create_spec(), headers=headers())

    _args, kwargs = modal_fake.create_calls[0]
    assert kwargs["secrets"] == [{images.BOOTSTRAP_ENV_KEY: "boot_sess_1_1"}]


def test_the_sandbox_is_tagged_with_its_session_and_generation(
    client, modal_fake: FakeModal
) -> None:
    """Write-only on purpose: Modal's tag search is running-only and ignores
    the caller's environment, so nothing reads them back. They identify a
    session's sandbox in Modal's dashboard."""
    client.post("/v1/create", json=create_spec(generation=4), headers=headers())

    _args, kwargs = modal_fake.create_calls[0]
    assert kwargs["tags"] == {"oncue_session": "sess_1", "oncue_generation": "4"}


def test_a_long_session_id_is_truncated_but_keeps_its_generation() -> None:
    import sandboxes

    name = sandboxes.sandbox_name("s" * 200, 12)

    assert len(name) <= sandboxes.MAX_NAME_LENGTH
    assert name.endswith("-g12")


def test_the_checkout_bundle_path_points_at_the_bridge_build_output() -> None:
    assert images.REPOSITORY_BRIDGE_BUNDLE.endswith("/services/bridge/dist/bridge.mjs")


def test_the_checkout_supervisor_bundle_path_points_at_the_bridge_build_output() -> None:
    assert images.REPOSITORY_SUPERVISOR_BUNDLE.endswith("/services/bridge/dist/supervisor.mjs")


def test_a_missing_bridge_bundle_is_an_image_preparation_failure(tmp_path):
    """The bundle is gitignored build output, so its absence is the likely
    deployment mistake, reported as `image_preparation`. Checked before the
    supervisor bundle, so a build missing both names the bridge bundle."""
    with pytest.raises(ControllerError) as raised:
        images.base_image(str(tmp_path / "never-built.js"))
    assert raised.value.category == "image_preparation"
    assert raised.value.retryable is False
    assert "bridge" in raised.value.message


def test_a_missing_supervisor_bundle_is_an_image_preparation_failure(tmp_path):
    """The same failure, but for the second bundle: a present bridge bundle
    must not hide an absent supervisor one."""
    bridge_bundle, _ = image_bundles(tmp_path)
    with pytest.raises(ControllerError) as raised:
        images.base_image(bridge_bundle, str(tmp_path / "never-built-supervisor.mjs"))
    assert raised.value.category == "image_preparation"
    assert raised.value.retryable is False
    assert "supervisor" in raised.value.message


def test_codex_is_pinned_by_the_registrys_digest_and_installed_roots(monkeypatch, tmp_path) -> None:
    """Codex arrives as the exact npm tarball the registry's sha512 names,
    unpacked root-owned and not writable by group or others, and the build
    fails unless the binary reports the pinned version. The bridge's
    supervisor allowlist names the same binary path."""
    commands: list[str] = []

    class Recorder:
        def run_commands(self, *entries: str) -> "Recorder":
            commands.extend(entries)
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    images.base_image(bridge_bundle, supervisor_bundle)

    for command in images.CODEX_INSTALL_COMMANDS:
        assert command in commands
    assert len(images.CODEX_PACKAGE_SHA512) == 128
    assert images.CODEX_PACKAGE_URL.endswith(f"codex-{images.CODEX_VERSION}-linux-x64.tgz")
    assert commands.index(images.CODEX_INSTALL_COMMANDS[1]) > commands.index(
        images.CODEX_INSTALL_COMMANDS[0]
    )
    assert f"chown -R root:root {images.CODEX_INSTALL_DIR}" in commands
    assert f"chmod -R go-w {images.CODEX_INSTALL_DIR}" in commands
    assert images.AGENT_CODEX_HOME_COMMAND in commands
    protocol = (
        Path(__file__).resolve().parents[2] / "bridge" / "src" / "supervisor-protocol.ts"
    ).read_text()
    assert f'export const CODEX_BINARY = "{images.CODEX_BIN_PATH}";' in protocol
    catalog = (
        Path(__file__).resolve().parents[3] / "packages" / "protocol" / "src" / "runtimes.ts"
    ).read_text()
    assert f'pinnedVersion: "{images.CODEX_VERSION}"' in catalog


def test_a_missing_runtime_host_bundle_is_an_image_preparation_failure(tmp_path):
    """The third bundle, found beside the supervisor bundle: present bridge and
    supervisor bundles must not hide an absent runtime host."""
    bridge_bundle = bundle(tmp_path, "bridge.mjs")
    supervisor_bundle = bundle(tmp_path, "supervisor.mjs")
    with pytest.raises(ControllerError) as raised:
        images.base_image(bridge_bundle, supervisor_bundle)
    assert raised.value.category == "image_preparation"
    assert raised.value.retryable is False
    assert "runtime host" in raised.value.message


def test_the_runtime_host_is_roots_and_read_only_and_the_bridge_names_the_same_path(
    monkeypatch, tmp_path
) -> None:
    """The agent user runs the runtime host and must read it; nobody but root
    may change it. The bridge's supervisor allowlist names the same path, so a
    move in one place and not the other would refuse every stdio harness."""
    order: list[tuple[str, str]] = []

    class Recorder:
        def add_local_file(self, source: str, remote_path: str, **_kwargs: object) -> "Recorder":
            order.append(("file", remote_path))
            return self

        def run_commands(self, *commands: str) -> "Recorder":
            for command in commands:
                order.append(("run", command))
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    images.base_image(bridge_bundle, supervisor_bundle)

    placed = order.index(("file", images.RUNTIME_HOST_PATH))
    owned = order.index(
        ("run", f"chown root:root {images.RUNTIME_HOST_DIR} {images.RUNTIME_HOST_PATH}")
    )
    assert placed < owned
    assert ("run", f"chmod 0755 {images.RUNTIME_HOST_DIR}") in order
    assert ("run", f"chmod 0444 {images.RUNTIME_HOST_PATH}") in order
    # The ownership check runs again after the host lands under /usr/local/lib,
    # over every harness's directory too.
    assert order[-1] == ("run", images.IMAGE_OWNERSHIP_CHECK)
    assert images.RUNTIME_HOST_PATH.startswith("/usr/local/lib/")

    protocol = (
        Path(__file__).resolve().parents[2] / "bridge" / "src" / "supervisor-protocol.ts"
    ).read_text()
    assert f'export const RUNTIME_HOST_PATH = "{images.RUNTIME_HOST_PATH}";' in protocol


def test_a_present_bundle_pair_is_accepted(tmp_path):
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    assert images.base_image(bridge_bundle, supervisor_bundle) is not None


def test_the_controller_image_carries_both_bundles() -> None:
    """The deployed controller can create nothing without these lines.

    `add_local_python_source` ships only `.py` files, so without the
    `add_local_file` lines neither bundle ships and every create fails.
    Asserted by recording what the image definition asks for, since a built
    `modal.Image` keeps its layers private.
    """
    recorded: list[tuple[str, str]] = []

    class Recorder:
        def add_local_file(self, source: str, remote_path: str, **_kwargs: object) -> "Recorder":
            recorded.append((source, remote_path))
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    images.controller_image(base=Recorder())

    assert (images.REPOSITORY_BRIDGE_BUNDLE, images.DEPLOYED_BRIDGE_BUNDLE) in recorded
    assert (images.REPOSITORY_SUPERVISOR_BUNDLE, images.DEPLOYED_SUPERVISOR_BUNDLE) in recorded
    assert (
        images.REPOSITORY_RUNTIME_HOST_BUNDLE,
        images.DEPLOYED_RUNTIME_HOST_BUNDLE,
    ) in recorded
    # Beside the supervisor bundle in both places, which is where `base_image` looks.
    assert Path(images.DEPLOYED_RUNTIME_HOST_BUNDLE).parent == Path(
        images.DEPLOYED_SUPERVISOR_BUNDLE
    ).parent
    assert Path(images.REPOSITORY_RUNTIME_HOST_BUNDLE).parent == Path(
        images.REPOSITORY_SUPERVISOR_BUNDLE
    ).parent


def test_the_deployed_bundle_is_preferred_over_the_checkout(monkeypatch, tmp_path) -> None:
    """The deployed container has no checkout, so the fixed path the image
    copied to must win."""
    deployed = tmp_path / "deployed.js"
    deployed.write_text("console.log('bridge')")
    monkeypatch.setattr(images, "DEPLOYED_BRIDGE_BUNDLE", str(deployed))

    assert images.bridge_bundle_path() == str(deployed)


def test_the_deployed_supervisor_bundle_is_preferred_over_the_checkout(monkeypatch, tmp_path) -> None:
    deployed = tmp_path / "deployed-supervisor.js"
    deployed.write_text("console.log('supervisor')")
    monkeypatch.setattr(images, "DEPLOYED_SUPERVISOR_BUNDLE", str(deployed))

    assert images.supervisor_bundle_path() == str(deployed)


def test_the_checkout_bundle_is_used_when_there_is_no_deployed_copy(monkeypatch, tmp_path) -> None:
    built = tmp_path / "dist" / "bridge.mjs"
    built.parent.mkdir()
    built.write_text("console.log('bridge')")
    monkeypatch.setattr(images, "DEPLOYED_BRIDGE_BUNDLE", str(tmp_path / "absent.js"))
    monkeypatch.setattr(images, "REPOSITORY_BRIDGE_BUNDLE", str(built))

    assert images.bridge_bundle_path() == str(built)


def test_the_checkout_supervisor_bundle_is_used_when_there_is_no_deployed_copy(
    monkeypatch, tmp_path
) -> None:
    built = tmp_path / "dist" / "supervisor.mjs"
    built.parent.mkdir()
    built.write_text("console.log('supervisor')")
    monkeypatch.setattr(images, "DEPLOYED_SUPERVISOR_BUNDLE", str(tmp_path / "absent.js"))
    monkeypatch.setattr(images, "REPOSITORY_SUPERVISOR_BUNDLE", str(built))

    assert images.supervisor_bundle_path() == str(built)


def test_no_bundle_anywhere_names_the_build_that_was_not_run(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(images, "DEPLOYED_BRIDGE_BUNDLE", str(tmp_path / "absent.js"))
    monkeypatch.setattr(images, "REPOSITORY_BRIDGE_BUNDLE", str(tmp_path / "also-absent.js"))

    with pytest.raises(ControllerError) as raised:
        images.bridge_bundle_path()

    assert raised.value.category == "image_preparation"
    assert "@oncue/bridge" in raised.value.message
    assert "bridge" in raised.value.message


def test_no_supervisor_bundle_anywhere_names_the_build_that_was_not_run(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(images, "DEPLOYED_SUPERVISOR_BUNDLE", str(tmp_path / "absent.js"))
    monkeypatch.setattr(images, "REPOSITORY_SUPERVISOR_BUNDLE", str(tmp_path / "also-absent.js"))

    with pytest.raises(ControllerError) as raised:
        images.supervisor_bundle_path()

    assert raised.value.category == "image_preparation"
    assert "@oncue/bridge" in raised.value.message
    assert "supervisor" in raised.value.message


def test_base_image_resolves_the_bundles_when_it_is_not_told_where_they_are(
    monkeypatch, tmp_path
) -> None:
    deployed_bridge = tmp_path / "deployed-bridge.js"
    deployed_bridge.write_text("console.log('bridge')")
    deployed_supervisor = tmp_path / "deployed-supervisor.js"
    deployed_supervisor.write_text("console.log('supervisor')")
    # The runtime host is found beside the supervisor bundle.
    (tmp_path / "runtime-host.mjs").write_text("console.log('runtime host')")
    monkeypatch.setattr(images, "DEPLOYED_BRIDGE_BUNDLE", str(deployed_bridge))
    monkeypatch.setattr(images, "DEPLOYED_SUPERVISOR_BUNDLE", str(deployed_supervisor))

    assert images.base_image() is not None


def test_bridge_home_is_closed_after_the_file_layers_land(monkeypatch, tmp_path) -> None:
    """Order is the assertion: `add_local_file` recreates the bridge home
    root-owned and world-listable, so ownership must be set after every file
    lands."""
    order: list[tuple[str, str]] = []

    class Recorder:
        def add_local_file(self, _source: str, remote_path: str, **_kwargs: object) -> "Recorder":
            order.append(("file", remote_path))
            return self

        def run_commands(self, *commands: str) -> "Recorder":
            for command in commands:
                order.append(("run", command))
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)

    images.base_image(bridge_bundle, supervisor_bundle)

    last_file = max(i for i, (kind, _) in enumerate(order) if kind == "file")
    closing = [i for i, (kind, command) in enumerate(order)
               if kind == "run" and command == f"chmod 0700 {images.BRIDGE_HOME}"]
    assert closing, "nothing closes the bridge home"
    assert closing[0] > last_file
    assert (
        "run",
        f"chown -R {images.BRIDGE_UID}:{images.BRIDGE_UID} {images.BRIDGE_HOME}",
    ) in order[last_file:]

    # The sweep sets everything under the bridge home to the bridge user;
    # `supervisor.mjs` and `askpass` are reclaimed for root after it, or the
    # sweep would undo the reclaim.
    sweep_index = next(
        i for i, (kind, command) in enumerate(order)
        if kind == "run" and command == f"chown -R {images.BRIDGE_UID}:{images.BRIDGE_UID} {images.BRIDGE_HOME}"
    )
    reclaim = [
        i for i, (kind, command) in enumerate(order)
        if kind == "run"
        and command == f"chown root:root {images.SUPERVISOR_BUNDLE_PATH} {images.ASKPASS_PATH}"
    ]
    assert reclaim, "supervisor.mjs and askpass are never reclaimed for root"
    assert reclaim[0] > sweep_index


def test_the_entrypoint_removes_every_setuid_and_setgid_file_at_start() -> None:
    """The image ships setuid and setgid files, and Modal's image capture does
    not keep their removal, so the root entrypoint removes them at start,
    before the credential is written and before `setpriv`."""
    script = images.ENTRYPOINT_SCRIPT
    assert images.STRIP_SETUID_COMMAND in script
    assert "-perm -4000" in images.STRIP_SETUID_COMMAND
    assert "-perm -2000" in images.STRIP_SETUID_COMMAND
    assert "-delete" in images.STRIP_SETUID_COMMAND
    assert script.index(images.STRIP_SETUID_COMMAND) < script.index("umask 022")
    assert script.index(images.STRIP_SETUID_COMMAND) < script.index("exec tini")


def test_the_sandbox_gets_the_environment_the_bridge_reads(monkeypatch) -> None:
    """The bridge exits without these variables. The bootstrap credential is
    absent; it is a Secret the entrypoint moves into a file."""
    monkeypatch.setenv(images.CONTROL_PLANE_ORIGIN_ENV_KEY, "https://oncue.example")
    options = images.sandbox_options(spec(), image="img", app="app", name="n", tags={}, secrets=[])
    assert options["env"] == {
        "ONCUE_SESSION_ID": "sess_1",
        "ONCUE_SANDBOX_GENERATION": "1",
        "ONCUE_CONTROL_PLANE_ORIGIN": "https://oncue.example",
        "ONCUE_BOOTSTRAP_FILE": images.BOOTSTRAP_FILE_PATH,
    }
    assert images.BOOTSTRAP_ENV_KEY not in options["env"]


def test_a_missing_or_plain_http_control_plane_origin_is_a_configuration_failure(monkeypatch) -> None:
    for value in (None, "", "http://oncue.example"):
        if value is None:
            monkeypatch.delenv(images.CONTROL_PLANE_ORIGIN_ENV_KEY, raising=False)
        else:
            monkeypatch.setenv(images.CONTROL_PLANE_ORIGIN_ENV_KEY, value)
        with pytest.raises(ControllerError) as raised:
            images.sandbox_options(spec(), image="img", app="app", name="n", tags={}, secrets=[])
        assert raised.value.category == "configuration"


def test_tini_is_an_apt_package() -> None:
    """The entrypoint execs `tini`, so it must be in the package list."""
    assert "tini" in images._APT_PACKAGES


def test_opencode_is_pinned_by_version_url_size_and_checksum() -> None:
    """One constants block, so an upgrade is a single edit that cannot drift."""
    assert images.OPENCODE_VERSION == "1.18.30"
    assert images.OPENCODE_URL == (
        "https://github.com/anomalyco/opencode/releases/download/"
        "v1.18.30/opencode-linux-x64.tar.gz"
    )
    assert images.OPENCODE_ARCHIVE_SIZE_BYTES == 60557284
    assert (
        images.OPENCODE_SHA256
        == "55007246858165496ff85ba1c2b648f7421e8e2013bf4189a680c9ff8e699d17"
    )
    assert len(images.OPENCODE_SHA256) == 64


def test_the_build_downloads_verifies_and_installs_opencode(monkeypatch, tmp_path) -> None:
    """The build commands use the pinned download, checksum, and extraction,
    and a checksum mismatch fails the build."""
    commands: list[str] = []

    class Recorder:
        def add_local_file(self, *_args: object, **_kwargs: object) -> "Recorder":
            return self

        def run_commands(self, *cmds: str) -> "Recorder":
            commands.extend(cmds)
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)

    images.base_image(bridge_bundle, supervisor_bundle)

    assert f"curl -fsSL -o /tmp/opencode.tar.gz {images.OPENCODE_URL}" in commands
    assert any(
        str(images.OPENCODE_ARCHIVE_SIZE_BYTES) in command and "stat" in command
        for command in commands
    )
    assert any(
        images.OPENCODE_SHA256 in command and "sha256sum -c" in command
        for command in commands
    )
    assert any(
        "tar -xzf /tmp/opencode.tar.gz" in command and images.OPENCODE_INSTALL_DIR in command
        for command in commands
    )


def test_opencode_is_installed_root_owned_and_agent_executable(monkeypatch, tmp_path) -> None:
    """Root:root 0755, both the binary and its directory: the agent user (who
    runs it) can read and execute it, but only root can change it."""
    commands: list[str] = []

    class Recorder:
        def add_local_file(self, *_args: object, **_kwargs: object) -> "Recorder":
            return self

        def run_commands(self, *cmds: str) -> "Recorder":
            commands.extend(cmds)
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)

    images.base_image(bridge_bundle, supervisor_bundle)

    assert (
        f"chown root:root {images.OPENCODE_INSTALL_DIR} {images.OPENCODE_BIN_PATH}" in commands
    )
    assert f"chmod 0755 {images.OPENCODE_INSTALL_DIR} {images.OPENCODE_BIN_PATH}" in commands


def test_pnpm_is_pinned_to_the_repositorys_own_version() -> None:
    """Verification installs from a pnpm lockfile as the agent user, so the
    image carries pnpm. The pin is exact, not a range, and it matches the
    `packageManager` this repository declares."""
    assert images.PNPM_VERSION == "10.24.0"
    assert images.PNPM_INSTALL_COMMAND == "npm install --global pnpm@10.24.0"
    assert images.PNPM_VERIFY_COMMAND == '[ "$(pnpm --version)" = "10.24.0" ]'
    assert "yarn" not in images._APT_PACKAGES


def test_the_build_installs_pnpm_after_node_and_checks_its_version(monkeypatch, tmp_path) -> None:
    """Installed in a build step, as root, and verified in the next one, so a
    registry answer of any other version fails the build rather than shipping."""
    commands: list[str] = []

    class Recorder:
        def add_local_file(self, *_args: object, **_kwargs: object) -> "Recorder":
            return self

        def run_commands(self, *cmds: str) -> "Recorder":
            commands.extend(cmds)
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)

    images.base_image(bridge_bundle, supervisor_bundle)

    install = commands.index(images.PNPM_INSTALL_COMMAND)
    assert commands.index(images.PNPM_VERIFY_COMMAND) == install + 1
    assert install > max(commands.index(command) for command in images.NODE_INSTALL_COMMANDS)


def _recorded_build_commands(monkeypatch, tmp_path) -> list[str]:
    commands: list[str] = []

    class Recorder:
        def add_local_file(self, *_args: object, **_kwargs: object) -> "Recorder":
            return self

        def run_commands(self, *cmds: str) -> "Recorder":
            commands.extend(cmds)
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    images.base_image(bridge_bundle, supervisor_bundle)
    return commands


def test_node_is_pinned_by_version_url_size_and_checksum() -> None:
    """Debian's Node 18 cannot install a repository that needs a current Node.
    The pin names one release, its archive, and nodejs.org's size and checksum
    in one block."""
    assert images.NODE_VERSION == "24.21.0"
    assert images.NODE_DIST == "node-v24.21.0-linux-x64"
    assert images.NODE_URL == (
        "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz"
    )
    assert images.NODE_ARCHIVE_SIZE_BYTES == 58088022
    assert (
        images.NODE_SHA256
        == "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
    )
    assert images.NODE_INSTALL_PREFIX == "/usr/local"


def test_node_does_not_come_from_the_distribution() -> None:
    """Debian's `nodejs` is Node 18 and its `npm` would sit beside the pinned
    one; neither may come back through the package list."""
    assert "nodejs" not in images._APT_PACKAGES
    assert "npm" not in images._APT_PACKAGES


def test_the_build_verifies_node_before_unpacking_it_and_checks_the_version(
    monkeypatch, tmp_path
) -> None:
    """Download, size, checksum, extract, clean up, version, presence: in that
    order and adjacent, so nothing runs from an archive that was not verified,
    a registry answer of any other release fails the build, and a path the
    ownership check relies on cannot be silently absent."""
    commands = _recorded_build_commands(monkeypatch, tmp_path)

    start = commands.index(images.NODE_INSTALL_COMMANDS[0])
    assert tuple(commands[start : start + len(images.NODE_INSTALL_COMMANDS)]) == (
        images.NODE_INSTALL_COMMANDS
    )
    download, size, checksum, extract, cleanup, version, present = images.NODE_INSTALL_COMMANDS
    assert download == f"curl -fsSL -o /tmp/node.tar.gz {images.NODE_URL}"
    assert "stat -c%s /tmp/node.tar.gz" in size and str(images.NODE_ARCHIVE_SIZE_BYTES) in size
    assert checksum == f"echo '{images.NODE_SHA256}  /tmp/node.tar.gz' | sha256sum -c -"
    assert extract.startswith("tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1")
    assert cleanup == "rm /tmp/node.tar.gz"
    assert version == '[ "$(node --version)" = "v24.21.0" ]'
    assert present.startswith("for p in ") and '[ -e "$p" ] || { echo "missing $p"; exit 1; }' in present


def test_node_is_unpacked_root_owned_and_only_its_runtime_directories(
    monkeypatch, tmp_path
) -> None:
    """The root supervisor executes this Node. A root tar keeps the archive's
    builder uid unless told not to, so `--no-same-owner` is required, and every
    Node path must exist. Only `bin`, `include`, `lib`, and `share` are
    extracted into /usr/local."""
    commands = _recorded_build_commands(monkeypatch, tmp_path)
    extract = images.NODE_INSTALL_COMMANDS[3]
    owners = images.NODE_INSTALL_COMMANDS[6]

    assert extract in commands and owners in commands
    assert "--no-same-owner" in extract
    dist = images.NODE_DIST
    assert extract.endswith(f"{dist}/bin {dist}/include {dist}/lib {dist}/share")
    for path in (
        "/usr/local/bin/node",
        "/usr/local/bin/npm",
        "/usr/local/bin/npx",
        "/usr/local/bin/corepack",
        "/usr/local/include/node",
        "/usr/local/lib/node_modules",
    ):
        assert path in images.NODE_OWNED_PATHS
        assert path in owners


def test_the_runtime_under_usr_local_is_checked_after_pnpm(monkeypatch, tmp_path) -> None:
    """After pnpm's global install, nothing under `/usr/local`'s `bin`, `lib`,
    or `include` may be another user's or writable by group or others, and an
    error from `find` fails the check rather than emptying its output."""
    check = images.RUNTIME_OWNERSHIP_CHECK
    assert check.startswith('[ -z "$(find /usr/local/bin /usr/local/lib /usr/local/include ')
    assert "! -type l" in check
    assert "! -user root -o ! -group root -o -perm /022" in check
    assert check.endswith('-print 2>&1)" ]')
    commands = _recorded_build_commands(monkeypatch, tmp_path)
    assert commands.index(check) == commands.index(images.PNPM_VERIFY_COMMAND) + 1


def test_the_agent_gets_a_private_temporary_directory(monkeypatch, tmp_path) -> None:
    """A sandbox's `/tmp` is 777 with no sticky bit, so the agent's tools write
    temporary files under its home instead: the directory the bridge names as
    `TMPDIR` (`agentTmpDir` in `opencode.ts`), agent-owned and 0700, created
    right after the agent user and before anything runs as it."""
    assert images.AGENT_HOME == "/home/oncue-agent"
    assert images.AGENT_TMP_DIR == "/home/oncue-agent/.tmp"
    assert images.AGENT_TMP_DIR_COMMAND == (
        "install -d -m 0700 -o 1001 -g 1001 /home/oncue-agent/.tmp"
    )
    commands = _recorded_build_commands(monkeypatch, tmp_path)
    useradd = commands.index(
        f"useradd --uid {images.AGENT_UID} --create-home --shell /bin/sh oncue-agent"
    )
    assert commands.index(images.AGENT_TMP_DIR_COMMAND) == useradd + 1
    assert not any("chmod" in c and "/tmp" in c and "1777" in c for c in commands)


def test_node_is_installed_after_curl_is_available(monkeypatch, tmp_path) -> None:
    """The download uses the distribution's curl, which the package list
    installs before any build command runs."""
    assert "curl" in images._APT_PACKAGES
    commands = _recorded_build_commands(monkeypatch, tmp_path)
    assert images.NODE_INSTALL_COMMANDS[0] in commands


def test_opencode_version_is_exposed_for_the_controller_to_report() -> None:
    assert images.OPENCODE_VERSION


def test_the_askpass_script_answers_gits_two_prompts_without_argv_or_echo() -> None:
    """Git calls this once for the username prompt and once for the password
    prompt, passing the prompt text as `$1`. The token must never travel as an
    argument, an environment variable, or a file -- only through file
    descriptor 3, which the caller opens onto the token before invoking git."""
    script = images.ASKPASS_SCRIPT

    assert "x-access-token" in script
    assert "<&3" in script
    assert "read -r token" in script
    # `$1` is only matched against a pattern, never printed: an echoed prompt
    # could leak the token into a log.
    assert 'echo "$1"' not in script
    assert "printf '%s\\n' \"$1\"" not in script
    assert script.count("$1") == 1


def test_the_askpass_script_is_root_owned_and_agent_executable(monkeypatch, tmp_path) -> None:
    """0555 root-owned: the agent user (who git runs as) can execute it, but
    neither the agent nor the bridge user can read or modify what it does."""
    order: list[tuple[str, str]] = []

    class Recorder:
        def add_local_file(self, _source: str, remote_path: str, **_kwargs: object) -> "Recorder":
            order.append(("file", remote_path))
            return self

        def run_commands(self, *commands: str) -> "Recorder":
            for command in commands:
                order.append(("run", command))
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)

    images.base_image(bridge_bundle, supervisor_bundle)

    assert ("file", images.ASKPASS_PATH) in order
    assert (
        "run",
        f"chown root:root {images.SUPERVISOR_BUNDLE_PATH} {images.ASKPASS_PATH}",
    ) in order
    assert ("run", f"chmod 0555 {images.ASKPASS_PATH}") in order


def test_the_workspace_is_owned_by_the_bridge_user_at_build(monkeypatch, tmp_path) -> None:
    """The bridge clones into `/workspace` at build time, so the image chowns it
    to the bridge user; the supervisor chowns it to the agent user at runtime
    before starting OpenCode."""
    commands: list[str] = []

    class Recorder:
        def add_local_file(self, *_args: object, **_kwargs: object) -> "Recorder":
            return self

        def run_commands(self, *cmds: str) -> "Recorder":
            commands.extend(cmds)
            return self

        def __getattr__(self, _name: str):
            return lambda *_args, **_kwargs: self

    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: Recorder())
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)

    images.base_image(bridge_bundle, supervisor_bundle)

    assert f"chown {images.BRIDGE_UID}:{images.BRIDGE_UID} {images.AGENT_WORKDIR}" in commands
    assert f"chown {images.AGENT_UID}:{images.AGENT_UID} {images.AGENT_WORKDIR}" not in commands


class _LayerRecorder:
    """Each `run_commands` call is one image layer; each `add_local_file` a file layer."""

    def __init__(self) -> None:
        self.layers: list[tuple[str, tuple[str, ...]]] = []

    def run_commands(self, *commands: str) -> "_LayerRecorder":
        self.layers.append(("run", commands))
        return self

    def add_local_file(self, _source: str, remote_path: str, **_kwargs: object) -> "_LayerRecorder":
        self.layers.append(("file", (remote_path,)))
        return self

    def __getattr__(self, _name: str):
        return lambda *_args, **_kwargs: self


def _layers(monkeypatch, tmp_path) -> list[tuple[str, tuple[str, ...]]]:
    recorder = _LayerRecorder()
    monkeypatch.setattr(images.modal.Image, "debian_slim", lambda **_kwargs: recorder)
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    images.base_image(bridge_bundle, supervisor_bundle)
    return recorder.layers


def test_each_enabled_harness_has_its_own_layer_between_opencodes_and_the_bundles(
    monkeypatch, tmp_path
) -> None:
    """The OpenCode, Node, and pnpm layer first, then one layer per enabled
    harness, then the bridge's files. Modal caches a layer by its commands and
    everything before it, so a Codex bump never rebuilds OpenCode's layer."""
    layers = _layers(monkeypatch, tmp_path)
    runs = [commands for kind, commands in layers if kind == "run"]
    base = runs[0]
    assert any(images.OPENCODE_URL in command for command in base)
    assert set(images.NODE_INSTALL_COMMANDS) <= set(base)
    assert images.PNPM_INSTALL_COMMAND in base
    assert base[-1] == images.RUNTIME_OWNERSHIP_CHECK
    # Nothing of any harness but OpenCode is in the base layer.
    assert not any(images.CODEX_INSTALL_DIR in command for command in base)
    assert images.AGENT_CODEX_HOME_COMMAND not in base

    assert [harness for harness, _ in images.HARNESS_LAYERS] == ["codex"]
    harness_layers = [(kind, commands) for kind, commands in layers[1:] if kind == "run"][
        : len(images.HARNESS_LAYERS)
    ]
    assert [commands for _, commands in harness_layers] == [
        commands for _, commands in images.HARNESS_LAYERS
    ]
    # The harness layers come straight after the base layer, before any file lands.
    first_file = next(index for index, (kind, _) in enumerate(layers) if kind == "file")
    assert layers[1 : 1 + len(images.HARNESS_LAYERS)] == [
        ("run", commands) for _, commands in images.HARNESS_LAYERS
    ]
    assert first_file == 1 + len(images.HARNESS_LAYERS)
    assert layers[first_file] == ("file", (images.BRIDGE_BUNDLE_PATH,))


def test_the_codex_layer_is_the_whole_codex_install_and_checks_its_own_ownership() -> None:
    """Codex's layer creates the agent's `CODEX_HOME`, installs the pinned
    package, and fails the build unless `/opt/codex` and `/usr/local` are
    root's and writable by nobody else; the image's last step repeats the
    check over every harness directory."""
    codex = dict(images.HARNESS_LAYERS)["codex"]
    assert codex[0] == images.AGENT_CODEX_HOME_COMMAND
    assert codex[1:-1] == images.CODEX_INSTALL_COMMANDS
    check = codex[-1]
    assert check == images.ownership_check(*images.RUNTIME_ROOTS, images.CODEX_INSTALL_DIR)
    assert f" {images.CODEX_INSTALL_DIR} ! -type l" in check
    assert images.CODEX_INSTALL_DIR in images.HARNESS_INSTALL_DIRS
    assert images.CODEX_INSTALL_DIR in images.IMAGE_OWNERSHIP_CHECK
    assert images.IMAGE_OWNERSHIP_CHECK.startswith(
        '[ -z "$(find /usr/local/bin /usr/local/lib /usr/local/include '
    )


def test_the_runtime_catalog_says_in_image_for_exactly_the_harnesses_installed() -> None:
    """The Worker refuses a harness whose catalog entry is not `inImage`, so the
    flag must name OpenCode (the base layer) and each `HARNESS_LAYERS` row,
    and nothing else."""
    catalog = (
        Path(__file__).resolve().parents[3] / "packages" / "protocol" / "src" / "runtimes.ts"
    ).read_text()
    entries = re.findall(
        r'^  (\w+): \{\n    id: "\1",\n(?:    [^\n]*\n)*?    inImage: (true|false),$',
        catalog,
        flags=re.MULTILINE,
    )
    assert [harness for harness, _ in entries] == ["opencode", "codex", "pi", "claude"]
    in_image = {harness for harness, flag in entries if flag == "true"}
    assert in_image == {"opencode", *(harness for harness, _ in images.HARNESS_LAYERS)}


def test_nothing_installs_a_harness_that_is_not_switched_on(monkeypatch, tmp_path) -> None:
    """Pi and Claude Code have adapters in the bridge but are not enabled, so
    no layer may install either."""
    layers = _layers(monkeypatch, tmp_path)
    everything = "\n".join(command for _kind, commands in layers for command in commands)
    for needle in (
        "pi-coding-agent",
        "/opt/pi",
        "pi-extension",
        "claude-agent-sdk",
        "claude-code",
        "/opt/claude",
    ):
        assert needle not in everything


def test_script_files_are_named_by_their_content(monkeypatch, tmp_path) -> None:
    """Two requests building the image at once must never read a half-written
    script, and a path holds only its own content."""
    monkeypatch.setattr(images.tempfile, "gettempdir", lambda: str(tmp_path))

    first = images._script_file("stem", "one")
    second = images._script_file("stem", "two")

    assert first != second
    assert Path(first).read_text() == "one"
    assert Path(second).read_text() == "two"
    # Only the two named files remain: each write renamed its staging file away.
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        [Path(first).name, Path(second).name]
    )


def test_an_existing_script_file_is_reused(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(images.tempfile, "gettempdir", lambda: str(tmp_path))
    path = Path(images._script_file("stem", "same"))
    before = path.stat().st_mtime_ns

    again = images._script_file("stem", "same")

    assert again == str(path)
    assert path.stat().st_mtime_ns == before


def test_a_tampered_script_file_is_rewritten(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(images.tempfile, "gettempdir", lambda: str(tmp_path))
    path = Path(images._script_file("stem", "content"))
    path.write_text("something else")

    images._script_file("stem", "content")

    assert path.read_text() == "content"


def test_concurrent_writers_of_one_script_all_see_the_whole_script(monkeypatch, tmp_path) -> None:
    import threading

    monkeypatch.setattr(images.tempfile, "gettempdir", lambda: str(tmp_path))
    content = "x" * 200_000
    seen: list[str] = []

    def write() -> None:
        seen.append(Path(images._script_file("stem", content)).read_text())

    threads = [threading.Thread(target=write) for _ in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert seen == [content] * 16
    assert len(list(tmp_path.iterdir())) == 1


def test_the_entrypoint_and_askpass_files_hold_their_scripts() -> None:
    assert Path(images._entrypoint_file()).read_text() == images.ENTRYPOINT_SCRIPT
    assert Path(images._askpass_file()).read_text() == images.ASKPASS_SCRIPT


def test_the_image_version_follows_the_bundles(monkeypatch, tmp_path) -> None:
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    monkeypatch.setattr(images, "DEPLOYED_BRIDGE_BUNDLE", bridge_bundle)
    monkeypatch.setattr(images, "DEPLOYED_SUPERVISOR_BUNDLE", supervisor_bundle)

    first = images.image_version()
    again = images.image_version()
    Path(bridge_bundle).write_text("console.log('a different bridge')")
    changed = images.image_version()

    assert first == again
    assert changed != first
    assert len(first) == 20


def test_an_unchanged_image_version_is_not_read_again(monkeypatch, tmp_path) -> None:
    bridge_bundle, supervisor_bundle = image_bundles(tmp_path)
    monkeypatch.setattr(images, "DEPLOYED_BRIDGE_BUNDLE", bridge_bundle)
    monkeypatch.setattr(images, "DEPLOYED_SUPERVISOR_BUNDLE", supervisor_bundle)
    images.image_version()
    reads: list[Path] = []
    original = Path.read_bytes

    def counting(self: Path) -> bytes:
        reads.append(self)
        return original(self)

    monkeypatch.setattr(Path, "read_bytes", counting)

    images.image_version()

    assert reads == []
