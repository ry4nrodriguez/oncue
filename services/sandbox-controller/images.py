"""The base coding image and the sandbox specification built from it.

The bridge is a Unix user, not a sidecar: Modal restricts sidecars to
allowlisted workspaces and OnCue runs on each user's own Modal credential, so
one container holds a bridge user and a separate, unprivileged agent user with
a cleared environment (record 02). This is weaker than process-level isolation.

The network policy is a domain allowlist with no CIDR list. An allowlist must
be present at creation to be adjustable later, but `outbound_cidr_allowlist=
["0.0.0.0/0"]` would permit every protocol to every address, including the
cloud metadata endpoint. `["*"]` on domains alone permits only TLS on 443
(record 09).
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import modal

from errors import error
from models import CreateSpec

# TLS to any host on 443, and nothing else. No `outbound_cidr_allowlist` and
# no `block_network` key: `block_network=True` cannot be combined with an
# allowlist, and an explicit `False` invites adding a CIDR list beside it.
# `test_images.py` asserts on this dictionary.
NETWORK_POLICY: dict[str, Any] = {"outbound_domain_allowlist": ["*"]}

# Where the entrypoint, the bridge bundle, and the credential live. Owned by
# the bridge user; the agent user has no read access to any of it.
BRIDGE_HOME = "/opt/oncue"

BRIDGE_UID = 1000
AGENT_UID = 1001
AGENT_HOME = "/home/oncue-agent"
# The agent's own temporary directory, handed to OpenCode and every check as
# `TMPDIR` (`agentTmpDir` in `services/bridge/src/opencode.ts`). A sandbox's
# `/tmp` is 777 with no sticky bit, so any user could replace files there.
# Created agent-owned and 0700 before any agent process starts. Only processes
# running as the agent user may be given it, never root or the bridge user.
AGENT_TMP_DIR = f"{AGENT_HOME}/.tmp"
AGENT_TMP_DIR_COMMAND = f"install -d -m 0700 -o {AGENT_UID} -g {AGENT_UID} {AGENT_TMP_DIR}"
# Codex's `CODEX_HOME`, which it requires to start; the agent's alone.
AGENT_CODEX_HOME = f"{AGENT_HOME}/.codex"
AGENT_CODEX_HOME_COMMAND = (
    f"install -d -m 0700 -o {AGENT_UID} -g {AGENT_UID} {AGENT_CODEX_HOME}"
)

# The agent's working tree. Agent-owned, so OpenCode can write a checkout
# without the bridge's files being writable.
AGENT_WORKDIR = "/workspace"

# The Modal Secret key the bootstrap credential arrives under. Every process
# would inherit it from the environment, so the entrypoint moves it to a file
# only the bridge user can read and drops it from the environment before
# anything else starts (record 02).
BOOTSTRAP_ENV_KEY = "ONCUE_BRIDGE_BOOTSTRAP"

ENTRYPOINT_PATH = f"{BRIDGE_HOME}/entrypoint.sh"
BRIDGE_BUNDLE_PATH = f"{BRIDGE_HOME}/bridge.mjs"
SUPERVISOR_BUNDLE_PATH = f"{BRIDGE_HOME}/supervisor.mjs"
# The runtime host (`services/bridge/src/runtime-host.ts`), which the
# supervisor starts as the agent user for a harness that talks over stdio.
# Outside the bridge's 0700 home so the agent can read it; root-owned and
# read-only so neither the agent nor the bridge can change it. Must equal
# `RUNTIME_HOST_PATH` in `supervisor-protocol.ts`; a test holds the two equal.
RUNTIME_HOST_DIR = "/usr/local/lib/oncue"
RUNTIME_HOST_PATH = f"{RUNTIME_HOST_DIR}/runtime-host.mjs"
BOOTSTRAP_FILE_PATH = f"{BRIDGE_HOME}/bootstrap"
ASKPASS_PATH = f"{BRIDGE_HOME}/askpass"

# OpenCode, installed as a standalone checksummed binary: the release is a
# compiled Bun binary with no runtime dependencies and publishes no checksum
# file, so the size and SHA-256 here are OnCue's own record of the pinned
# release. Upgrading it requires re-running test C, since the agent user
# executes this binary.
OPENCODE_VERSION = "1.18.30"
OPENCODE_URL = (
    "https://github.com/anomalyco/opencode/releases/download/"
    f"v{OPENCODE_VERSION}/opencode-linux-x64.tar.gz"
)
OPENCODE_ARCHIVE_SIZE_BYTES = 60557284
OPENCODE_SHA256 = "55007246858165496ff85ba1c2b648f7421e8e2013bf4189a680c9ff8e699d17"

# Codex, the second harness, from npm's linux-x64 package, pinned by the
# registry's sha512 integrity for that tarball and unpacked root-owned. It
# starts only when a session's harness is Codex, and `ONCUE_RUNTIME_ALLOWLIST`
# keeps it off until named. Upgrading it requires re-running test C. This pin
# has not yet run inside a Modal sandbox.
CODEX_VERSION = "0.157.1"
CODEX_PACKAGE_URL = (
    f"https://registry.npmjs.org/@openai/codex/-/codex-{CODEX_VERSION}-linux-x64.tgz"
)
CODEX_PACKAGE_SHA512 = (
    "11a73c5e50b49c25d27948c353d97cc8b27a3fd7afbf598ef809ef20ba0dc257"
    "a0042ec1dc0557a89d3941c321417ed1709dcb936eb5f329026f65f6ba2f1501"
)
CODEX_PACKAGE_TRIPLE_DIR = "package/vendor/x86_64-unknown-linux-musl"
CODEX_INSTALL_DIR = "/opt/codex"
# `CODEX_BINARY` in `supervisor-protocol.ts`; a test holds the two equal.
CODEX_BIN_PATH = f"{CODEX_INSTALL_DIR}/bin/codex"
CODEX_INSTALL_COMMANDS = (
    f"curl -fsSL -o /tmp/codex.tgz {CODEX_PACKAGE_URL}",
    f"echo '{CODEX_PACKAGE_SHA512}  /tmp/codex.tgz' | sha512sum -c -",
    f"mkdir -p {CODEX_INSTALL_DIR}",
    (
        f"tar -xzf /tmp/codex.tgz -C {CODEX_INSTALL_DIR} --strip-components=3 --no-same-owner "
        f"{CODEX_PACKAGE_TRIPLE_DIR}"
    ),
    "rm /tmp/codex.tgz",
    f"chown -R root:root {CODEX_INSTALL_DIR}",
    f"chmod -R go-w {CODEX_INSTALL_DIR}",
    f'"{CODEX_BIN_PATH}" --version | grep -qF "{CODEX_VERSION}"',
)


# Root-owned and 0755, file and directory alike, so the agent user can run
# the binary but cannot modify it.
OPENCODE_INSTALL_DIR = "/opt/opencode"
OPENCODE_BIN_PATH = f"{OPENCODE_INSTALL_DIR}/opencode"

# Node.js, pinned and checksummed like OpenCode, because Debian bookworm's
# `nodejs` is Node 18. The linux-x64 archive is unpacked into /usr/local, first
# on the sandbox PATH. `--no-same-owner` matters: the archive carries the
# release builder's uid, which a root tar keeps by default, leaving the runtime
# the root supervisor executes owned by an unprivileged uid. Only `bin`,
# `include`, `lib`, and `share` are extracted. Version, size, and checksum come
# from nodejs.org's SHASUMS256.txt. Upgrading Node changes what the supervisor
# and bridge run on, so it requires re-running test C.
NODE_VERSION = "24.21.0"
NODE_DIST = f"node-v{NODE_VERSION}-linux-x64"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_DIST}.tar.gz"
NODE_ARCHIVE_SIZE_BYTES = 58088022
NODE_SHA256 = "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
NODE_INSTALL_PREFIX = "/usr/local"
NODE_OWNED_PATHS = (
    f"{NODE_INSTALL_PREFIX}/bin/node",
    f"{NODE_INSTALL_PREFIX}/bin/npm",
    f"{NODE_INSTALL_PREFIX}/bin/npx",
    f"{NODE_INSTALL_PREFIX}/bin/corepack",
    f"{NODE_INSTALL_PREFIX}/include/node",
    f"{NODE_INSTALL_PREFIX}/lib/node_modules",
)
NODE_INSTALL_COMMANDS = (
    f"curl -fsSL -o /tmp/node.tar.gz {NODE_URL}",
    f'[ "$(stat -c%s /tmp/node.tar.gz)" = "{NODE_ARCHIVE_SIZE_BYTES}" ]',
    f"echo '{NODE_SHA256}  /tmp/node.tar.gz' | sha256sum -c -",
    (
        f"tar -xzf /tmp/node.tar.gz -C {NODE_INSTALL_PREFIX} --strip-components=1 --no-same-owner "
        f"{NODE_DIST}/bin {NODE_DIST}/include {NODE_DIST}/lib {NODE_DIST}/share"
    ),
    "rm /tmp/node.tar.gz",
    f'[ "$(node --version)" = "v{NODE_VERSION}" ]',
    # Every path the ownership check relies on must exist, so a release that
    # drops one fails here instead of passing that check vacuously.
    "for p in " + " ".join(NODE_OWNED_PATHS) + '; do [ -e "$p" ] || { echo "missing $p"; exit 1; }; done',
)

# What the root supervisor and every check execute from `/usr/local` must be
# root's and not writable by group or others. Symlinks are skipped (their mode
# is always 777), and `find`'s errors go to the same stream so an unreadable
# path fails the check. `share` is not executed and is left out, because
# Debian ships `/usr/local/share/fonts` group-writable to `staff`.
def ownership_check(*roots: str) -> str:
    """The build step that fails unless everything under `roots` is root's and
    writable by nobody else (symlinks skipped, `find`'s errors counted)."""
    return (
        f'[ -z "$(find {" ".join(roots)} ! -type l '
        '\\( ! -user root -o ! -group root -o -perm /022 \\) -print 2>&1)" ]'
    )


RUNTIME_ROOTS = ("/usr/local/bin", "/usr/local/lib", "/usr/local/include")
RUNTIME_OWNERSHIP_CHECK = ownership_check(*RUNTIME_ROOTS)

# One layer per enabled harness, built after the OpenCode, Node, and pnpm
# layer and before the bridge's files. Modal caches a layer by its commands and
# everything before it, so a Codex bump rebuilds only its layer and what
# follows. Harnesses that are not enabled stay out of the image;
# `test_images.py` pins the order. Each harness layer ends with the ownership
# check widened to its install directory, and the image's last step repeats it.
CODEX_LAYER_COMMANDS = (
    AGENT_CODEX_HOME_COMMAND,
    *CODEX_INSTALL_COMMANDS,
    ownership_check(*RUNTIME_ROOTS, CODEX_INSTALL_DIR),
)
HARNESS_LAYERS: tuple[tuple[str, tuple[str, ...]], ...] = (("codex", CODEX_LAYER_COMMANDS),)
HARNESS_INSTALL_DIRS = (CODEX_INSTALL_DIR,)
IMAGE_OWNERSHIP_CHECK = ownership_check(*RUNTIME_ROOTS, *HARNESS_INSTALL_DIRS)

# Verification installs a repository's dependencies from its lockfile before
# any check, and a pnpm lockfile needs pnpm. Pinned to this repository's
# version, installed root-owned through the pinned Node's npm, and checked by
# version. yarn is not installed: a yarn lockfile's install fails and its
# required checks are recorded as skipped.
PNPM_VERSION = "10.24.0"
PNPM_INSTALL_COMMAND = f"npm install --global pnpm@{PNPM_VERSION}"
PNPM_VERIFY_COMMAND = f'[ "$(pnpm --version)" = "{PNPM_VERSION}" ]'

# Test C requires no practical privilege-escalation path, and the base image
# carries setuid and setgid files (su, mount, passwd, chrome-sandbox, and
# others) that nothing in the sandbox needs: remote Git is HTTPS through the
# bridge and Chromium runs headless with --no-sandbox.
#
# They are removed by the entrypoint at container start, not in the image,
# because Modal's image capture does not keep deletions or mode changes to
# files from the apt layer. Explicit directories rather than `/`, so `find`
# never descends into /proc, /sys, or /dev.
STRIP_SETUID_COMMAND = (
    r"find /usr /bin /sbin /lib /lib64 /opt /etc /var /root /home -type f "
    r"\( -perm -4000 -o -perm -2000 \) -delete"
)

# The entrypoint stays root and hands off to the root supervisor under `tini`
# as a subreaper (`-s`), because Modal's own init is PID 1. The bootstrap
# credential passes through `tini`'s exec to the supervisor, which moves it to
# the bridge-owned file and drops it from its environment before spawning
# anything (record 02). The umask is 022, not 077: the bridge and the agent
# inherit it, and the bridge must read the agent's files to diff and push.
ENTRYPOINT_SCRIPT = f"""#!/bin/sh
set -eu
{STRIP_SETUID_COMMAND}
umask 022
exec tini -s -- node {SUPERVISOR_BUNDLE_PATH}
"""

# Answers git's credential prompts with a GitHub App installation token that
# never appears in argv, the environment, or a file: the bridge opens fd 3
# onto a pipe holding the token, and the script never echoes `$1`, which
# could leak the token into a log. Root-owned and 0555 so the bridge (git's
# user, record 07) cannot change it.
ASKPASS_SCRIPT = """#!/bin/sh
set -eu
case "$1" in
  *sername*) printf '%s\\n' 'x-access-token' ;;
  *) IFS= read -r token <&3
     printf '%s\\n' "$token" ;;
esac
"""

# Record 02's sandbox contents. Chromium comes from the distribution so the
# image has one package manager to audit. Node is installed separately above.
_APT_PACKAGES = (
    "ca-certificates",
    "chromium",
    "curl",
    "git",
    "tini",
    "util-linux",
)

_RESOURCE_CLASSES: dict[str, dict[str, Any]] = {
    # `(request, limit)` pairs. Modal bills sandboxes on `max(request,
    # actual)`, so the request is what costs money; the limit is headroom.
    "standard": {"cpu": (1.0, 2.0), "memory": (2048, 4096)},
}

# `(timeout, idle_timeout)` in seconds, with no idle timeout on purpose.
# Modal counts a sandbox as active only while an exec runs, stdin is written,
# or a tunnel holds a connection, and OnCue's bridge only dials out, so an
# `idle_timeout` would be an absolute cap from create. The idle stop is the
# session object's alarm (record 11); the 24-hour `timeout` is only a
# backstop. The policy name stays because the Worker sends it and the two
# deploy separately.
_EXPIRATION_POLICIES: dict[str, tuple[int, int | None]] = {
    "idle_20m": (86_400, None),
}


# The bridge bundle lives in one of two places. In a checkout,
# `services/bridge/build.ts` writes it beside this file's parent. In the
# deployed controller's container, which has no checkout, `controller_image`
# copies it to the DEPLOYED path.
DEPLOYED_BRIDGE_BUNDLE = "/opt/oncue-controller/bridge.mjs"

REPOSITORY_BRIDGE_BUNDLE = str(
    Path(__file__).resolve().parent.parent / "bridge" / "dist" / "bridge.mjs"
)

# The root supervisor bundle `tini` execs, resolved the same two ways.
DEPLOYED_SUPERVISOR_BUNDLE = "/opt/oncue-controller/supervisor.mjs"

REPOSITORY_SUPERVISOR_BUNDLE = str(
    Path(__file__).resolve().parent.parent / "bridge" / "dist" / "supervisor.mjs"
)

# The runtime host bundle, looked for beside the supervisor bundle wherever
# that one was found.
DEPLOYED_RUNTIME_HOST_BUNDLE = "/opt/oncue-controller/runtime-host.mjs"

REPOSITORY_RUNTIME_HOST_BUNDLE = str(
    Path(__file__).resolve().parent.parent / "bridge" / "dist" / "runtime-host.mjs"
)

# Deployed by `app.py`; listed here beside the image that carries them.
CONTROLLER_MODULES = (
    "app",
    "connection",
    "errors",
    "images",
    "models",
    "prepare",
    "sandboxes",
)

PINNED_MODAL_VERSION = "1.5.5"


def _missing_bundle_error(which: str) -> Any:
    return error(
        "image_preparation",
        f"The sandbox image needs the {which} bundle; "
        "run `pnpm --filter @oncue/bridge build` before deploying the controller.",
        retryable=False,
    )


def bridge_bundle_path() -> str:
    """Where the bridge bundle is, deployed copy first.

    Neither existing means the bridge build was not run before deploying,
    reported as `image_preparation` with the fix rather than as a
    file-not-found from inside the Modal SDK.
    """
    if Path(DEPLOYED_BRIDGE_BUNDLE).is_file():
        return DEPLOYED_BRIDGE_BUNDLE
    if Path(REPOSITORY_BRIDGE_BUNDLE).is_file():
        return REPOSITORY_BRIDGE_BUNDLE
    raise _missing_bundle_error("bridge")


def supervisor_bundle_path() -> str:
    """Where the supervisor bundle is, resolved like `bridge_bundle_path()`."""
    if Path(DEPLOYED_SUPERVISOR_BUNDLE).is_file():
        return DEPLOYED_SUPERVISOR_BUNDLE
    if Path(REPOSITORY_SUPERVISOR_BUNDLE).is_file():
        return REPOSITORY_SUPERVISOR_BUNDLE
    raise _missing_bundle_error("supervisor")


def controller_image(base: Any = None) -> Any:
    """The image the controller itself runs in, not the one sessions run in.

    `add_local_python_source` carries `.py` files only, so the
    `add_local_file` lines are what ship the bundles; without them every
    create in the deployed controller fails. `base` lets `test_images.py` pass
    a recorder, since a built `modal.Image` keeps its layers private.
    """
    if base is None:
        base = modal.Image.debian_slim(python_version="3.12")
    return (
        base.pip_install(f"modal=={PINNED_MODAL_VERSION}", "fastapi[standard]>=0.115")
        .add_local_file(REPOSITORY_BRIDGE_BUNDLE, DEPLOYED_BRIDGE_BUNDLE, copy=True)
        .add_local_file(REPOSITORY_SUPERVISOR_BUNDLE, DEPLOYED_SUPERVISOR_BUNDLE, copy=True)
        .add_local_file(REPOSITORY_RUNTIME_HOST_BUNDLE, DEPLOYED_RUNTIME_HOST_BUNDLE, copy=True)
        .add_local_python_source(*CONTROLLER_MODULES)
    )


def base_image(
    bridge_bundle: str | None = None, supervisor_bundle: str | None = None
) -> modal.Image:
    """The image every session's main container starts from.

    The bundles are added as files because they are unpublished build output
    that must match the control plane exactly. Omitted paths are resolved by
    `*_bundle_path()`. A missing bundle raises `image_preparation` naming the
    bridge build, checked bridge first so a build missing all of them names
    one thing to fix.
    """
    if bridge_bundle is None:
        bridge_bundle = bridge_bundle_path()
    if not Path(bridge_bundle).is_file():
        raise _missing_bundle_error("bridge")
    if supervisor_bundle is None:
        supervisor_bundle = supervisor_bundle_path()
    if not Path(supervisor_bundle).is_file():
        raise _missing_bundle_error("supervisor")
    runtime_host_bundle = str(Path(supervisor_bundle).parent / "runtime-host.mjs")
    if not Path(runtime_host_bundle).is_file():
        raise _missing_bundle_error("runtime host")
    # The OpenCode, Node, and pnpm layer. No harness but OpenCode is installed here.
    image = (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install(*_APT_PACKAGES)
        .run_commands(
            f"useradd --uid {BRIDGE_UID} --create-home --shell /usr/sbin/nologin oncue-bridge",
            f"useradd --uid {AGENT_UID} --create-home --shell /bin/sh oncue-agent",
            AGENT_TMP_DIR_COMMAND,
            f"mkdir -p {BRIDGE_HOME} {AGENT_WORKDIR} {OPENCODE_INSTALL_DIR}",
            # Chowned to the bridge user at build because the bridge clones the
            # repository into it; the supervisor chowns it to the agent user at
            # runtime, right before starting the agent.
            f"chown {BRIDGE_UID}:{BRIDGE_UID} {AGENT_WORKDIR}",
            # `sha256sum -c` fails the build on a mismatch. The size check
            # before it turns a truncated or redirected download into a clear
            # early failure.
            f"curl -fsSL -o /tmp/opencode.tar.gz {OPENCODE_URL}",
            f'[ "$(stat -c%s /tmp/opencode.tar.gz)" = "{OPENCODE_ARCHIVE_SIZE_BYTES}" ]',
            f"echo '{OPENCODE_SHA256}  /tmp/opencode.tar.gz' | sha256sum -c -",
            f"tar -xzf /tmp/opencode.tar.gz -C {OPENCODE_INSTALL_DIR} opencode",
            "rm /tmp/opencode.tar.gz",
            f"chown root:root {OPENCODE_INSTALL_DIR} {OPENCODE_BIN_PATH}",
            f"chmod 0755 {OPENCODE_INSTALL_DIR} {OPENCODE_BIN_PATH}",
            *NODE_INSTALL_COMMANDS,
            PNPM_INSTALL_COMMAND,
            PNPM_VERIFY_COMMAND,
            RUNTIME_OWNERSHIP_CHECK,
        )
    )
    # One layer per enabled harness, each its own cache entry (`HARNESS_LAYERS`).
    for _harness, commands in HARNESS_LAYERS:
        image = image.run_commands(*commands)
    return (
        image.add_local_file(bridge_bundle, BRIDGE_BUNDLE_PATH, copy=True)
        .add_local_file(supervisor_bundle, SUPERVISOR_BUNDLE_PATH, copy=True)
        .add_local_file(runtime_host_bundle, RUNTIME_HOST_PATH, copy=True)
        .add_local_file(_entrypoint_file(), ENTRYPOINT_PATH, copy=True)
        .add_local_file(_askpass_file(), ASKPASS_PATH, copy=True)
        # Ownership is set after every file lands, because `add_local_file`
        # recreates the directory root-owned and world-listable. The bridge
        # home stays 0700 and bridge-owned (root bypasses DAC checks to read
        # `supervisor.mjs` inside it). `supervisor.mjs` and `askpass` are then
        # reclaimed for root, so neither the bridge nor the agent can modify
        # them.
        .run_commands(
            f"chown -R {BRIDGE_UID}:{BRIDGE_UID} {BRIDGE_HOME}",
            f"chmod 0700 {BRIDGE_HOME}",
            f"chmod 0500 {ENTRYPOINT_PATH}",
            f"chmod 0400 {BRIDGE_BUNDLE_PATH}",
            f"chown root:root {SUPERVISOR_BUNDLE_PATH} {ASKPASS_PATH}",
            f"chmod 0400 {SUPERVISOR_BUNDLE_PATH}",
            f"chmod 0555 {ASKPASS_PATH}",
            # The runtime host: root's file in root's directory, readable by
            # the agent user who runs it and writable by nobody else.
            f"chown root:root {RUNTIME_HOST_DIR} {RUNTIME_HOST_PATH}",
            f"chmod 0755 {RUNTIME_HOST_DIR}",
            f"chmod 0444 {RUNTIME_HOST_PATH}",
            IMAGE_OWNERSHIP_CHECK,
        )
    )


def _script_file(stem: str, content: str) -> str:
    """`content` as a local file for `add_local_file`, safe under concurrency.

    The path is named by the content's digest and written through a unique
    temporary file and an atomic rename, so two requests building the image at
    once never read a half-written script, and a path never holds anything but
    its own content. Modal caches a file by content, so an unchanged script
    never rebuilds.
    """
    digest = hashlib.sha256(content.encode()).hexdigest()[:16]
    directory = Path(tempfile.gettempdir())
    path = directory / f"{stem}-{digest}.sh"
    if path.is_file() and path.read_text() == content:
        return str(path)
    descriptor, staging = tempfile.mkstemp(prefix=f"{stem}-", suffix=".tmp", dir=directory)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(content)
    os.replace(staging, path)
    return str(path)


def _entrypoint_file() -> str:
    """The entrypoint as a local file. Each `run_commands` entry becomes one
    Dockerfile `RUN` line, which cannot hold a multi-line script."""
    return _script_file("oncue-sandbox-entrypoint", ENTRYPOINT_SCRIPT)


def _askpass_file() -> str:
    """The askpass script as a local file, for the same reason as the entrypoint."""
    return _script_file("oncue-sandbox-askpass", ASKPASS_SCRIPT)


# Keyed by each input's path, size, and modification time, so a rebuilt
# bundle changes the version without restarting the controller, and an
# unchanged one is not read again on every request.
_VERSION_CACHE: dict[tuple[tuple[str, int, int], ...], str] = {}


def image_version() -> str:
    """A digest of everything the sandbox image is built from.

    It covers this module, whose constants and commands are the image's recipe,
    and the three bundles. It names an image without building it, so the
    controller can tell whether a workspace's prepared image is the current
    one. A comment-only change here also changes it, which costs one needless
    preparation and nothing else.
    """
    inputs = (
        str(Path(__file__).resolve()),
        bridge_bundle_path(),
        supervisor_bundle_path(),
        str(Path(supervisor_bundle_path()).parent / "runtime-host.mjs"),
    )
    keys: list[tuple[str, int, int]] = []
    for name in inputs:
        stat = Path(name).stat()
        keys.append((name, stat.st_size, stat.st_mtime_ns))
    cache_key = tuple(keys)
    cached = _VERSION_CACHE.get(cache_key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    for name in inputs:
        digest.update(Path(name).read_bytes())
        digest.update(b"\0")
    version = digest.hexdigest()[:20]
    _VERSION_CACHE.clear()
    _VERSION_CACHE[cache_key] = version
    return version


def sandbox_options(
    spec: CreateSpec,
    *,
    image: Any,
    app: Any,
    name: str,
    tags: dict[str, str],
    secrets: list[Any],
) -> dict[str, Any]:
    """Every keyword `Sandbox.create` is called with, as a plain dictionary,
    so a test can assert on it without building an image or reaching Modal."""
    resources = _RESOURCE_CLASSES.get(spec.resourceClass)
    if resources is None:
        raise _configuration(f"unknown resource class: {spec.resourceClass}")
    expiration = _EXPIRATION_POLICIES.get(spec.expirationPolicy)
    if expiration is None:
        raise _configuration(f"unknown expiration policy: {spec.expirationPolicy}")
    timeout, idle_timeout = expiration

    options: dict[str, Any] = {
        "app": app,
        "image": image,
        "name": name,
        "tags": tags,
        "secrets": secrets,
        "env": bridge_environment(spec),
        "workdir": AGENT_WORKDIR,
        "timeout": timeout,
        "idle_timeout": idle_timeout,
        **resources,
        **NETWORK_POLICY,
    }
    if spec.regionPreference is not None:
        options["region"] = spec.regionPreference
    return options


# Where the bridge dials: the OnCue Worker's public origin for this
# controller's environment. It is a deployment setting, so it lives in the
# same Modal Secret as the controller token.
CONTROL_PLANE_ORIGIN_ENV_KEY = "ONCUE_CONTROL_PLANE_ORIGIN"


def bridge_environment(spec: CreateSpec) -> dict[str, str]:
    """What `services/bridge/src/main.ts` reads at start, and nothing else.

    The bootstrap credential is not here: it arrives as a Secret and the
    entrypoint moves it into a file only the bridge user can read.
    """
    origin = os.environ.get(CONTROL_PLANE_ORIGIN_ENV_KEY, "").strip()
    if not origin.startswith("https://"):
        raise _configuration(
            f"{CONTROL_PLANE_ORIGIN_ENV_KEY} must be the control plane's https origin"
        )
    return {
        "ONCUE_SESSION_ID": spec.sessionId,
        "ONCUE_SANDBOX_GENERATION": str(spec.generation),
        "ONCUE_CONTROL_PLANE_ORIGIN": origin,
        "ONCUE_BOOTSTRAP_FILE": BOOTSTRAP_FILE_PATH,
    }


def entrypoint_command() -> list[str]:
    """The argv `Sandbox.create` is given positionally.

    The bridge's outbound WebSocket does not count as activity for Modal's
    idle timer, so record 11's keep-alive rules run in the control plane.
    """
    return ["/bin/sh", ENTRYPOINT_PATH]


def _configuration(message: str) -> Exception:
    return error("configuration", message, retryable=False)
