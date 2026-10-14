"""Run feasibility test C against a live OnCue sandbox and print the evidence as JSON.

Test C asks whether the agent user can reach anything the bridge user holds.
Every probe runs as the agent user (uid 1001) through `setpriv` with an empty
environment, from a root `exec`. The bootstrap credential is hashed inside the
sandbox and never leaves it: the JSON carries its length and a hash prefix, and
each sentinel probe counts where the credential appears.

Usage, under the Modal profile that owns the sandbox:

    uv run python scripts/test_c_probe.py <sandbox-id> > results.json

Exits 1 when any probe differs from what isolation requires.

`--secret NAME` adds the development-secret probes, for a session that was
supplied that secret so `/var/lib/oncue/secrets/<NAME>` exists. The value is
read only inside the sandbox, as root, and only its length and a hash prefix
leave it; the secret sentinel probes require it to appear nowhere else (the
bridge user's home or environment, check logs, the work tree). Without the
flag those probes are skipped and the JSON says so.
"""

import json
import sys

import modal

AGENT = "setpriv --reuid=1001 --regid=1001 --clear-groups env -i sh -c"

# What root executes, or runs checks and the agent from. A file here writable
# by the agent or bridge user is root code execution at the next start, and
# the build-time check cannot rule that out alone because Modal's image
# capture does not keep every mode change (see `STRIP_SETUID_COMMAND` in
# images.py).
ROOT_RUNTIME_PATHS = (
    "/usr/local /usr/bin /usr/sbin /usr/lib /opt/opencode /opt/codex /opt/oncue/supervisor.mjs"
)
ROOT_RUNTIME_WRITABLE = (
    f"find {ROOT_RUNTIME_PATHS} -xdev -writable ! -type l 2>/dev/null | head -5"
)
# The agent's own temporary directory. Only the agent may reach it.
AGENT_TMP_DIR = "/home/oncue-agent/.tmp"
# Composer attachments: root:bridge 0771. The bridge writes one directory per
# message and the supervisor hands it to the agent (0700 directory, 0600
# files), so nobody but the agent reads a placed file, not even the bridge.
ATTACHMENTS_ROOT = "/var/lib/oncue/attachments"
# The runtime host a stdio harness runs under: root:root, 0444 in a 0755
# directory (`RUNTIME_HOST_PATH` in images.py and supervisor-protocol.ts).
RUNTIME_HOST_DIR = "/usr/local/lib/oncue"
RUNTIME_HOST_PATH = f"{RUNTIME_HOST_DIR}/runtime-host.mjs"
# Codex's own state (its CODEX_HOME): the agent's alone, like its temporary directory.
AGENT_CODEX_HOME = "/home/oncue-agent/.codex"

ROOT_FACTS = {
    "process_table": "ps -eo pid,ppid,user,comm",
    "modes": (
        "stat -c '%a %U:%G %n' /opt/oncue /opt/oncue/bootstrap /opt/oncue/supervisor.sock "
        "/workspace /var/lib/oncue /var/lib/oncue/checks /var/lib/oncue/base "
        f"{ATTACHMENTS_ROOT} 2>&1"
    ),
    "check_logs": "stat -c '%a %U:%G %n' /var/lib/oncue/checks/* 2>/dev/null | head -5",
    "bootstrap_bytes": "wc -c < /opt/oncue/bootstrap",
    "bootstrap_sha256_prefix": "sha256sum /opt/oncue/bootstrap | cut -c1-12",
    "pnpm_version": "su -s /bin/sh -c 'pnpm --version' oncue-agent 2>&1 || pnpm --version",
}

SENTINEL = "SENTINEL=$(cat /opt/oncue/bootstrap)"

# name -> (command run as the agent, predicate on (exit, output) that isolation requires)
AGENT_PROBES = {
    "read_bootstrap_file": ("cat /opt/oncue/bootstrap", lambda code, out: code != 0),
    "list_bridge_home": ("ls /opt/oncue", lambda code, out: code != 0),
    "read_pid1_environ": ("cat /proc/1/environ", lambda code, out: code != 0),
    "ptrace_scope": ("cat /proc/sys/kernel/yama/ptrace_scope", lambda code, out: out.strip() in {"1", "2", "3"}),
    "su_sudo_present": (
        "command -v su sudo || echo none",
        lambda code, out: out.strip() == "none",
    ),
    "setuid_files": (
        "find / -xdev -perm /6000 -type f 2>/dev/null | grep -v '^/proc' | head -5",
        lambda code, out: out.strip() == "",
    ),
    "agent_capeff": ("grep CapEff /proc/self/status", lambda code, out: out.strip().endswith("0000000000000000")),
    "supervisor_socket_connect": (
        "node -e \"require('net').connect('/opt/oncue/supervisor.sock').on('connect',()=>{console.log('connected');process.exit(0)}).on('error',()=>{console.log('denied');process.exit(0)})\"",
        lambda code, out: out.strip() == "denied",
    ),
    "list_check_logs": ("ls /var/lib/oncue/checks", lambda code, out: code != 0),
    "read_check_log": (
        "cat /var/lib/oncue/checks/*.log 2>&1 | head -1",
        lambda code, out: "Permission denied" in out or "No such file" in out,
    ),
    "list_base_root": ("ls /var/lib/oncue/base", lambda code, out: code != 0),
    "create_in_base_root": (
        "mkdir /var/lib/oncue/base/probe 2>&1 && echo created || echo refused",
        lambda code, out: out.strip().endswith("refused"),
    ),
    "list_attachments_root": (f"ls {ATTACHMENTS_ROOT}", lambda code, out: code != 0),
    "create_in_attachments_root": (
        f"mkdir {ATTACHMENTS_ROOT}/probe 2>&1 && echo created || echo refused",
        lambda code, out: out.strip().endswith("refused"),
    ),
    "agent_env_names": ("env | cut -d= -f1 | sort | tr '\\n' ' '", lambda code, out: True),
    "write_workspace": (
        "touch /workspace/.oncue-test-c && rm /workspace/.oncue-test-c && echo works",
        lambda code, out: out.strip() == "works",
    ),
    "root_runtime_writable_by_agent": (
        ROOT_RUNTIME_WRITABLE,
        lambda code, out: out.strip() == "",
    ),
    # The runtime host (harness adapters): the agent runs it, so it must read
    # it, and must not be able to change it or put another file beside it.
    "runtime_host_read_only": (
        f"test -r {RUNTIME_HOST_PATH} && ! test -w {RUNTIME_HOST_PATH} "
        f"&& ! test -w {RUNTIME_HOST_DIR} && echo read-only || echo wrong",
        lambda code, out: out.strip() == "read-only",
    ),
    "workspace_git_credentials": (
        "cd /workspace && echo helper=$(git config --get credential.helper || echo unset) "
        "pushurl=$(git config --get remote.origin.pushurl) "
        "url_has_token=$(git config --get remote.origin.url | grep -c '@' )",
        lambda code, out: "helper=unset" in out and "pushurl=/dev/null" in out and "url_has_token=0" in out,
    ),
}

# Counted as root, because only root can read every environment; the agent's
# reach is what the counts are compared against.
SENTINEL_PROBES = {
    # Counted as root: no placed attachment or its directory is readable by
    # group or others, so only its owner, the agent, reads it.
    "attachments_not_shared": (
        f"find {ATTACHMENTS_ROOT} -mindepth 1 \\( -perm -g+r -o -perm -o+r \\) 2>/dev/null | head -5",
        lambda code, out: out.strip() == "",
    ),
    "attachments_owned_by_agent": (
        f"find {ATTACHMENTS_ROOT} -mindepth 1 ! -uid 1001 2>/dev/null | head -5",
        lambda code, out: out.strip() == "",
    ),
    "sentinel_in_agent_readable_environ": (
        f"{SENTINEL}; n=0; h=0; for f in /proc/[0-9]*/environ; do "
        f"if setpriv --reuid=1001 --regid=1001 --clear-groups cat $f >/dev/null 2>&1; then n=$((n+1)); "
        f"setpriv --reuid=1001 --regid=1001 --clear-groups cat $f 2>/dev/null | grep -qaF \"$SENTINEL\" && h=$((h+1)); fi; done; "
        "echo readable=$n hits=$h",
        lambda code, out: out.strip().endswith("hits=0"),
    ),
    # Counted as root: the harness and everything it started, a subagent's
    # commands included (a subagent is a conversation inside the harness's own
    # process, record 12), run as the agent user. `sleeps` counts the `sleep`
    # a slow subagent of a live lane runs, as evidence a subagent was working.
    "harness_process_tree_is_agent": (
        "p=$(pgrep -o -f '/opt/opencode/opencode'); if [ -z \"$p\" ]; then echo tree=0; exit 0; fi; "
        "ps -eo pid=,ppid=,uid=,comm= | awk -v root=\"$p\" "
        "'{ppid[$1]=$2; uid[$1]=$3; comm[$1]=$4} END {n=0; bad=0; s=0; "
        'for (q in ppid) { x=q; while (x != "" && x != root && x != 1 && x != 0) x=ppid[x]; '
        'if (x == root) { n++; if (uid[q] != 1001) bad++; if (comm[q] == "sleep") s++ } } '
        "print \"tree=\" n \" not_agent=\" bad \" sleeps=\" s}'",
        lambda code, out: "tree=0" not in out and " not_agent=0 " in f"{out} ",
    ),
    "sentinel_in_agent_files": (
        f"{SENTINEL}; setpriv --reuid=1001 --regid=1001 --clear-groups "
        "grep -rlaF \"$SENTINEL\" /workspace /tmp /home 2>/dev/null | wc -l",
        lambda code, out: out.strip() == "0",
    ),
}


BRIDGE = "setpriv --reuid=1000 --regid=1000 --clear-groups env -i sh -c"
SECRETS_DIR = "/var/lib/oncue/secrets"

# Run as the bridge user on every run, with or without a secret.
BRIDGE_PROBES = {
    "root_runtime_writable_by_bridge": (
        ROOT_RUNTIME_WRITABLE,
        lambda code, out: out.strip() == "",
    ),
    "bridge_cannot_list_agent_tmp": (
        f"ls {AGENT_TMP_DIR} 2>&1 >/dev/null && echo listed || echo denied",
        lambda code, out: out.strip().endswith("denied"),
    ),
    "bridge_cannot_list_agent_codex_home": (
        f"ls {AGENT_CODEX_HOME} 2>&1 >/dev/null && echo listed || echo denied",
        lambda code, out: out.strip().endswith("denied"),
    ),
    # Every attachment placed so far was handed to the agent: the bridge that
    # wrote it can no longer read it. With none placed, nothing is listed.
    "bridge_cannot_read_placed_attachments": (
        f"find {ATTACHMENTS_ROOT} -mindepth 2 -readable 2>/dev/null | head -5",
        lambda code, out: out.strip() == "",
    ),
}


def secret_root_facts(name: str) -> dict[str, str]:
    """Read as root. The value never leaves the sandbox: length and a hash prefix only."""
    path = f"{SECRETS_DIR}/{name}"
    return {
        "secrets_dir_mode": f"stat -c '%a %U:%G %n' {SECRETS_DIR} 2>&1",
        "secret_file_mode": f"stat -c '%a %U:%G %n' {path} 2>&1",
        "secret_bytes": f"wc -c < {path}",
        "secret_sha256_prefix": f"sha256sum {path} | cut -c1-12",
        "secrets_dir_entries": f"ls -A {SECRETS_DIR} | tr '\\n' ' '",
    }


def secret_agent_probes(name: str) -> dict[str, tuple[str, object]]:
    """Run as the agent: it can read its own secret and nothing more than that."""
    path = f"{SECRETS_DIR}/{name}"
    return {
        "agent_reads_own_secret": (
            f"test -r {path} && wc -c < {path}",
            lambda code, out: code == 0 and out.strip().isdigit() and int(out.strip()) >= 8,
        ),
        "agent_cannot_write_secret": (
            # The group's redirect also catches the shell's own "cannot create"
            # message, so the verdict stays the last line.
            f"{{ echo x >> {path}; }} 2>&1 && echo written || echo refused",
            lambda code, out: out.strip().endswith("refused"),
        ),
        "agent_cannot_create_in_secrets_dir": (
            f"touch {SECRETS_DIR}/PLANTED 2>&1 && echo created || echo refused",
            lambda code, out: out.strip().endswith("refused"),
        ),
        "agent_cannot_remove_secret": (
            f"rm -f {path} 2>&1 && test ! -e {path} && echo removed || echo refused",
            lambda code, out: out.strip().endswith("refused"),
        ),
        # The symlink trap `supervisor-protocol.ts` names: a file the agent
        # plants where a value could be written, pointing somewhere it can read.
        # The directory refuses the plant; a name that reached the supervisor
        # after such a plant is opened O_NOFOLLOW|O_EXCL and refused too.
        "agent_cannot_plant_symlink": (
            f"ln -s /workspace/stolen {SECRETS_DIR}/PLANTED_LINK 2>&1 && echo planted || echo refused",
            lambda code, out: out.strip().endswith("refused"),
        ),
    }


def secret_bridge_probes(name: str) -> dict[str, tuple[str, object]]:
    """Run as the bridge user (uid 1000): the bridge never reads the file back."""
    path = f"{SECRETS_DIR}/{name}"
    return {
        "bridge_cannot_read_secret": (
            f"cat {path} 2>&1 | head -c 0; test -r {path} && echo readable || echo denied",
            lambda code, out: out.strip().endswith("denied"),
        ),
        "bridge_cannot_list_secrets_dir": (
            f"ls {SECRETS_DIR} 2>&1 >/dev/null && echo listed || echo denied",
            lambda code, out: out.strip().endswith("denied"),
        ),
    }


def secret_sentinel_probes(name: str) -> dict[str, tuple[str, object]]:
    """Counted as root against the value read in the sandbox. Every count must be 0.

    The agent's own home and temporary directory are not searched: the value is
    the agent's to read, and OpenCode's session store keeps raw tool output (the
    bridge redacts only what leaves the sandbox). The bridge user cannot list
    the agent's temporary directory, which `bridge_cannot_list_agent_tmp`
    checks. The boundary measured is the bridge's home and files and every
    temporary directory both users can write. The agent's environment is read
    as root from OpenCode's process, since `env -i` gives a probe an empty one.
    """
    read = f"SECRET=$(cat {SECRETS_DIR}/{name})"
    return {
        "secret_in_bridge_home_or_env_files": (
            f"{read}; grep -rlaF \"$SECRET\" /opt/oncue /home/oncue-bridge 2>/dev/null | wc -l",
            lambda code, out: out.strip() == "0",
        ),
        "secret_not_in_opencode_environ": (
            f"{read}; n=0; h=0; for p in $(pgrep -f '/opt/opencode/opencode'); do n=$((n+1)); "
            f"cat /proc/$p/environ 2>/dev/null | grep -qaF \"$SECRET\" && h=$((h+1)); done; echo found=$n hits=$h",
            # A run with no runtime to read is no evidence.
            lambda code, out: "found=0" not in out and out.strip().endswith("hits=0"),
        ),
        "secret_in_check_logs": (
            f"{read}; grep -rlaF \"$SECRET\" /var/lib/oncue/checks 2>/dev/null | wc -l",
            lambda code, out: out.strip() == "0",
        ),
        "secret_in_work_tree_or_shared_tmp": (
            f"{read}; grep -rlaF \"$SECRET\" /workspace /tmp /var/tmp /dev/shm 2>/dev/null | wc -l",
            lambda code, out: out.strip() == "0",
        ),
        "secret_in_any_environ": (
            f"{read}; h=0; for f in /proc/[0-9]*/environ; do "
            f"cat $f 2>/dev/null | grep -qaF \"$SECRET\" && h=$((h+1)); done; echo hits=$h",
            lambda code, out: out.strip().endswith("hits=0"),
        ),
    }


def run(sandbox: modal.Sandbox, command: str) -> tuple[int, str]:
    process = sandbox.exec("sh", "-c", command, timeout=120)
    process.wait()
    out = (process.stdout.read() + process.stderr.read()).strip()
    return process.returncode, out


def parse_args(argv: list[str]) -> tuple[str, str | None] | None:
    """`<sandbox-id> [--secret NAME]`, or None when the arguments are not that."""
    if len(argv) == 2:
        return argv[1], None
    if len(argv) == 4 and argv[2] == "--secret" and argv[3]:
        return argv[1], argv[3]
    return None


def main() -> int:
    parsed = parse_args(sys.argv)
    if parsed is None:
        print("usage: test_c_probe.py <sandbox-id> [--secret NAME]", file=sys.stderr)
        return 2
    sandbox_id, secret = parsed
    sandbox = modal.Sandbox.from_id(sandbox_id)
    results: dict[str, object] = {"sandbox": sandbox_id, "secret_name": secret}
    root_facts = dict(ROOT_FACTS)
    agent_probes: dict[str, tuple[str, object]] = dict(AGENT_PROBES)
    bridge_probes: dict[str, tuple[str, object]] = dict(BRIDGE_PROBES)
    sentinel_probes: dict[str, tuple[str, object]] = dict(SENTINEL_PROBES)
    if secret is not None:
        root_facts.update(secret_root_facts(secret))
        agent_probes.update(secret_agent_probes(secret))
        bridge_probes.update(secret_bridge_probes(secret))
        sentinel_probes.update(secret_sentinel_probes(secret))
    for name, command in root_facts.items():
        results[name] = run(sandbox, command)[1]
    checks: dict[str, dict[str, object]] = {}
    failed: list[str] = []

    def record(name: str, code: int, out: str, holds: object) -> None:
        ok = bool(holds(code, out))  # type: ignore[operator]
        checks[name] = {"exit": code, "out": out[:400], "holds": ok}
        if not ok:
            failed.append(name)

    for name, (command, holds) in agent_probes.items():
        quoted = command.replace("'", "'\\''")
        code, out = run(sandbox, f"{AGENT} '{quoted}'")
        record(name, code, out, holds)
    for name, (command, holds) in bridge_probes.items():
        quoted = command.replace("'", "'\\''")
        code, out = run(sandbox, f"{BRIDGE} '{quoted}'")
        record(name, code, out, holds)
    for name, (command, holds) in sentinel_probes.items():
        code, out = run(sandbox, command)
        record(name, code, out, holds)
    results["checks"] = checks
    results["failed"] = failed
    results["secret_probes_ran"] = secret is not None
    print(json.dumps(results, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
