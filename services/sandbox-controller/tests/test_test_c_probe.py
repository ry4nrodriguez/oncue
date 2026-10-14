"""The live test C probe's own logic: which probes run, and what each accepts.

The probe runs only against a real sandbox, so these tests stub the sandbox
and check the verdicts, not the commands' effects.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import test_c_probe as probe  # noqa: E402


def holds(table: dict, name: str, out: str, code: int = 0) -> bool:
    return bool(table[name][1](code, out))


def test_nothing_root_runs_may_be_writable_by_the_agent_or_the_bridge() -> None:
    """The root supervisor's interpreter lives under /usr/local; both
    unprivileged users are asked, and any path `find -writable` prints fails."""
    assert "/usr/local" in probe.ROOT_RUNTIME_PATHS
    assert "/opt/oncue/supervisor.mjs" in probe.ROOT_RUNTIME_PATHS
    assert "-writable ! -type l" in probe.ROOT_RUNTIME_WRITABLE
    for table, name in (
        (probe.AGENT_PROBES, "root_runtime_writable_by_agent"),
        (probe.BRIDGE_PROBES, "root_runtime_writable_by_bridge"),
    ):
        assert table[name][0] == probe.ROOT_RUNTIME_WRITABLE
        assert holds(table, name, "")
        assert not holds(table, name, "/usr/local/bin/node")


def test_the_bridge_user_cannot_list_the_agents_temporary_directory() -> None:
    command, _ = probe.BRIDGE_PROBES["bridge_cannot_list_agent_tmp"]
    assert probe.AGENT_TMP_DIR == "/home/oncue-agent/.tmp"
    assert probe.AGENT_TMP_DIR in command
    assert holds(probe.BRIDGE_PROBES, "bridge_cannot_list_agent_tmp", "Permission denied\ndenied")
    assert not holds(probe.BRIDGE_PROBES, "bridge_cannot_list_agent_tmp", "listed")


def test_a_secret_is_searched_for_in_every_temporary_directory_both_users_can_write() -> None:
    """A sandbox's /tmp is 777, and /var/tmp and /dev/shm are 1777: any of them
    could carry a value from the agent's side to the bridge's."""
    command, _ = probe.secret_sentinel_probes("STRIPE_TEST_KEY")["secret_in_work_tree_or_shared_tmp"]
    for place in ("/workspace", "/tmp", "/var/tmp", "/dev/shm"):
        assert f" {place}" in command
    assert "/home/oncue-agent" not in command


def test_placed_attachments_are_the_agents_alone() -> None:
    """Composer attachments: the root is listable by nobody but root and the
    bridge's group, and a placed file is readable by the agent only."""
    assert probe.ATTACHMENTS_ROOT == "/var/lib/oncue/attachments"
    assert holds(probe.AGENT_PROBES, "list_attachments_root", "Permission denied", code=2)
    assert not holds(probe.AGENT_PROBES, "list_attachments_root", "m1-abc", code=0)
    assert holds(probe.AGENT_PROBES, "create_in_attachments_root", "Permission denied\nrefused")
    assert not holds(probe.AGENT_PROBES, "create_in_attachments_root", "created")
    placed = f"{probe.ATTACHMENTS_ROOT}/m1-abc/1-screen.png"
    assert holds(probe.BRIDGE_PROBES, "bridge_cannot_read_placed_attachments", "")
    assert not holds(probe.BRIDGE_PROBES, "bridge_cannot_read_placed_attachments", placed)
    for name in ("attachments_not_shared", "attachments_owned_by_agent"):
        assert probe.ATTACHMENTS_ROOT in probe.SENTINEL_PROBES[name][0]
        assert holds(probe.SENTINEL_PROBES, name, "")
        assert not holds(probe.SENTINEL_PROBES, name, placed)
    assert probe.ATTACHMENTS_ROOT in probe.ROOT_FACTS["modes"]


def test_codex_is_roots_and_its_home_is_the_agents_alone() -> None:
    """Codex's install is root's, like every harness's, and its state
    directory is the agent's: the bridge cannot even list it."""
    import images

    assert "/opt/codex" in probe.ROOT_RUNTIME_PATHS
    assert probe.AGENT_CODEX_HOME == images.AGENT_CODEX_HOME
    command, _ = probe.BRIDGE_PROBES["bridge_cannot_list_agent_codex_home"]
    assert probe.AGENT_CODEX_HOME in command
    assert holds(probe.BRIDGE_PROBES, "bridge_cannot_list_agent_codex_home", "Permission denied\ndenied")
    assert not holds(probe.BRIDGE_PROBES, "bridge_cannot_list_agent_codex_home", "listed")


def test_the_runtime_host_is_read_only_to_the_agent() -> None:
    """The agent runs the runtime host for a stdio harness, so it reads the
    file; it must not be able to change it or add one beside it. The path is
    the image's own."""
    import images

    assert probe.RUNTIME_HOST_PATH == images.RUNTIME_HOST_PATH
    assert holds(probe.AGENT_PROBES, "runtime_host_read_only", "read-only")
    assert not holds(probe.AGENT_PROBES, "runtime_host_read_only", "wrong")
    assert probe.RUNTIME_HOST_PATH in probe.AGENT_PROBES["runtime_host_read_only"][0]


def test_the_harness_and_everything_it_started_run_as_the_agent() -> None:
    """A subagent's commands run under the harness's own process (record 12),
    so the whole tree under OpenCode must be the agent's, and a probe that
    found no OpenCode is no evidence."""
    name = "harness_process_tree_is_agent"
    assert "/opt/opencode/opencode" in probe.SENTINEL_PROBES[name][0]
    assert holds(probe.SENTINEL_PROBES, name, "tree=4 not_agent=0 sleeps=1")
    assert holds(probe.SENTINEL_PROBES, name, "tree=10 not_agent=0 sleeps=0")
    assert not holds(probe.SENTINEL_PROBES, name, "tree=4 not_agent=1 sleeps=1")
    assert not holds(probe.SENTINEL_PROBES, name, "tree=4 not_agent=10 sleeps=1")
    assert not holds(probe.SENTINEL_PROBES, name, "tree=0")


def test_the_bridge_probes_run_without_a_secret(monkeypatch, capsys) -> None:
    ran: list[str] = []

    def fake_run(_sandbox: object, command: str) -> tuple[int, str]:
        ran.append(command)
        if command.startswith(probe.BRIDGE) and "ls /home/oncue-agent/.tmp" in command:
            return 0, "denied"
        return 0, ""

    monkeypatch.setattr(probe, "run", fake_run)
    monkeypatch.setattr(probe.modal.Sandbox, "from_id", staticmethod(lambda _id: object()))
    monkeypatch.setattr(sys, "argv", ["test_c_probe.py", "sb-test"])

    probe.main()

    results = json.loads(capsys.readouterr().out)
    assert results["secret_probes_ran"] is False
    for name in probe.BRIDGE_PROBES:
        assert name in results["checks"]
    assert any(command.startswith(probe.BRIDGE) for command in ran)
