import { describe, expect, it } from "vitest";
import { refuseSecretName } from "./secret-names";
import {
  AGENT_UID,
  ALLOWED_BINARY,
  ALLOWED_CWD,
  ALLOWED_ENV_KEYS,
  ATTACHMENTS_ROOT,
  BASE_ENV_KEYS,
  BASE_TREE_ROOT,
  CHECK_ENV_KEYS,
  CHECK_OUTPUT_DIR,
  type CheckPaths,
  checkOutputPath,
  DEFAULT_SPAWN_RUNTIME,
  encodeRequest,
  encodeResponse,
  hostedArgvPrefix,
  isAttachmentDir,
  isBaseTreeDir,
  LineSplitter,
  MAX_CHECK_COMMAND_BYTES,
  MAX_CHECK_TIMEOUT_MS,
  MAX_ENV_VALUE_BYTES,
  MAX_LINE_BYTES,
  NODE_BINARY,
  parseRequest,
  parseResponse,
  RELAY_PLACEHOLDER,
  RUNTIME_HOST_PATH,
  RUNTIME_SPAWN_RULES,
  type RuntimeSpawnRule,
  requestIdOf,
  reviewPrepareAttachments,
  reviewPrepareBase,
  reviewRequest,
  reviewRunCheck,
  reviewRuntimeArgv,
  reviewRuntimeEnv,
  SANDBOX_CHECK_PATHS,
  SECRETS_DIR,
  type SupervisorRequest,
  type SupervisorResponse,
  secretFilePath,
  spawnRuleFor,
} from "./supervisor-protocol";

function start(
  overrides: Partial<Extract<SupervisorRequest, { op: "start_agent" }>> = {},
): SupervisorRequest {
  return {
    op: "start_agent",
    requestId: "req_1",
    argv: [ALLOWED_BINARY, "serve", "--port", "4096"],
    cwd: ALLOWED_CWD,
    env: { PATH: "/usr/bin", HOME: "/home/oncue-agent", XDG_DATA_HOME: "/tmp/x" },
    uid: AGENT_UID,
    ...overrides,
  };
}

type RunCheck = Extract<SupervisorRequest, { op: "run_check" }>;

function check(overrides: Partial<RunCheck> = {}): RunCheck {
  return {
    op: "run_check",
    requestId: "req_check",
    checkRunId: "chk_1",
    command: "pnpm run test",
    cwd: ALLOWED_CWD,
    env: { PATH: "/usr/bin", HOME: "/home/oncue-agent", CI: "1" },
    uid: AGENT_UID,
    timeoutMs: MAX_CHECK_TIMEOUT_MS,
    outputPath: `${CHECK_OUTPUT_DIR}/chk_1.log`,
    ...overrides,
  };
}

describe("reviewRequest: chown_workspace", () => {
  it("allows the agent uid", () => {
    const request: SupervisorRequest = { op: "chown_workspace", requestId: "r", uid: AGENT_UID };
    expect(reviewRequest(request)).toEqual({ kind: "allowed", request });
  });

  it.each([0, 1000, 1002, -1])("refuses uid %d", (uid) => {
    expect(reviewRequest({ op: "chown_workspace", requestId: "r", uid })).toEqual({
      kind: "refused",
      denial: "uid_not_allowed",
    });
  });
});

describe("reviewRequest: start_agent", () => {
  it("allows the one binary, as the one uid, in the one directory, with allowlisted keys", () => {
    expect(reviewRequest(start())).toEqual({ kind: "allowed", request: start() });
  });

  it("allows an empty environment and any flags after the binary", () => {
    const request = start({ env: {}, argv: [ALLOWED_BINARY, "--anything", "at", "all"] });
    expect(reviewRequest(request).kind).toBe("allowed");
  });

  it.each([
    ["a different binary", { argv: ["/bin/sh", "-c", ALLOWED_BINARY] }, "binary_not_allowed"],
    [
      "the binary under another path",
      { argv: ["/opt/opencode/../opencode/opencode"] },
      "binary_not_allowed",
    ],
    ["the bridge's uid", { uid: 1000 }, "uid_not_allowed"],
    ["root", { uid: 0 }, "uid_not_allowed"],
    ["a cwd outside the workspace", { cwd: "/opt/oncue" }, "cwd_not_allowed"],
    ["a cwd below the workspace", { cwd: "/workspace/sub" }, "cwd_not_allowed"],
    ["an ONCUE_ key", { env: { ONCUE_SESSION_ID: "s" } }, "env_key_not_allowed"],
    ["a provider key name", { env: { ANTHROPIC_API_KEY: "x" } }, "env_key_not_allowed"],
    [
      "a lowercase spelling of an allowed key",
      { env: { path: "/usr/bin" } },
      "env_key_not_allowed",
    ],
  ] as const)("refuses %s", (_name, overrides, denial) => {
    expect(reviewRequest(start(overrides))).toEqual({ kind: "refused", denial });
  });

  it("checks every key, not only the first", () => {
    expect(
      reviewRequest(start({ env: { PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "t" } })),
    ).toEqual({
      kind: "refused",
      denial: "env_key_not_allowed",
    });
  });

  it("measures values in bytes", () => {
    const ascii = "a".repeat(MAX_ENV_VALUE_BYTES);
    expect(reviewRequest(start({ env: { OPENCODE_CONFIG_CONTENT: ascii } })).kind).toBe("allowed");
    expect(reviewRequest(start({ env: { OPENCODE_CONFIG_CONTENT: `${ascii}a` } }))).toEqual({
      kind: "refused",
      denial: "env_value_too_long",
    });
    // Same character count as the allowed case, twice the bytes.
    const twoByte = "é".repeat(MAX_ENV_VALUE_BYTES);
    expect(reviewRequest(start({ env: { OPENCODE_CONFIG_CONTENT: twoByte } }))).toEqual({
      kind: "refused",
      denial: "env_value_too_long",
    });
  });

  it("checks the binary before the uid, so a refusal names the first wrong thing", () => {
    expect(reviewRequest(start({ argv: ["/bin/sh"], uid: 0 }))).toEqual({
      kind: "refused",
      denial: "binary_not_allowed",
    });
  });
});

describe("the runtime table", () => {
  /** A made-up stdio harness under the runtime host, so the test does not depend on a real row. */
  const HOSTED: RuntimeSpawnRule = {
    kind: "hosted",
    binary: "/opt/harness/harness",
    envKeys: [...BASE_ENV_KEYS, "HARNESS_HOME"],
    placeholderKeys: ["HARNESS_AUTH_TOKEN"],
  };

  it("has OpenCode's row, direct, with its configuration keys and the switch that ignores the repository's own", () => {
    expect(RUNTIME_SPAWN_RULES.opencode).toEqual({
      kind: "direct",
      binary: ALLOWED_BINARY,
      envKeys: ALLOWED_ENV_KEYS,
      placeholderKeys: [],
    });
    expect(ALLOWED_ENV_KEYS).toEqual([
      ...BASE_ENV_KEYS,
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
    ]);
    expect(DEFAULT_SPAWN_RUNTIME).toBe("opencode");
  });

  it("names no row for no key a harness could hold a credential in", () => {
    for (const rule of Object.values(RUNTIME_SPAWN_RULES)) {
      for (const key of rule.envKeys) {
        expect(key).not.toMatch(/(TOKEN|KEY|SECRET|PASSWORD)$/);
      }
    }
  });

  it("finds the row a start names, OpenCode's when it names none, and none for anything else", () => {
    expect(spawnRuleFor(undefined)).toBe(RUNTIME_SPAWN_RULES.opencode);
    expect(spawnRuleFor("opencode")).toBe(RUNTIME_SPAWN_RULES.opencode);
    expect(spawnRuleFor("cursor")).toBeNull();
    expect(spawnRuleFor("toString")).toBeNull();
  });

  it("starts a hosted harness only as node, the runtime host, a port, and the binary", () => {
    const argv = [...hostedArgvPrefix(4100, HOSTED.binary), "app-server"];
    expect(argv.slice(0, 6)).toEqual([
      NODE_BINARY,
      RUNTIME_HOST_PATH,
      "--port",
      "4100",
      "--",
      HOSTED.binary,
    ]);
    expect(reviewRuntimeArgv(HOSTED, argv)).toBeNull();
  });

  it.each([
    [
      "another interpreter",
      ["/usr/bin/node", RUNTIME_HOST_PATH, "--port", "4100", "--", "/opt/harness/harness"],
    ],
    [
      "another host script",
      [NODE_BINARY, "/tmp/host.mjs", "--port", "4100", "--", "/opt/harness/harness"],
    ],
    [
      "no port flag",
      [NODE_BINARY, RUNTIME_HOST_PATH, "--listen", "4100", "--", "/opt/harness/harness"],
    ],
    [
      "a port that is not a number",
      [NODE_BINARY, RUNTIME_HOST_PATH, "--port", "4100x", "--", "/opt/harness/harness"],
    ],
    ["port zero", [NODE_BINARY, RUNTIME_HOST_PATH, "--port", "0", "--", "/opt/harness/harness"]],
    [
      "a port past the range",
      [NODE_BINARY, RUNTIME_HOST_PATH, "--port", "65536", "--", "/opt/harness/harness"],
    ],
    ["no separator", [NODE_BINARY, RUNTIME_HOST_PATH, "--port", "4100", "/opt/harness/harness"]],
    ["another binary", [NODE_BINARY, RUNTIME_HOST_PATH, "--port", "4100", "--", "/bin/sh"]],
    ["too short", [NODE_BINARY, RUNTIME_HOST_PATH]],
  ])("refuses a hosted start with %s", (_name, argv) => {
    expect(reviewRuntimeArgv(HOSTED, argv)).toBe("binary_not_allowed");
  });

  it("takes a placeholder key only with the relay's placeholder, and every other key only from the row", () => {
    expect(
      reviewRuntimeEnv(HOSTED, { HARNESS_AUTH_TOKEN: RELAY_PLACEHOLDER, HARNESS_HOME: "/h" }),
    ).toBeNull();
    expect(RELAY_PLACEHOLDER).toBe("oncue-relay");
    expect(reviewRuntimeEnv(HOSTED, { HARNESS_AUTH_TOKEN: "sk-real" })).toBe("env_key_not_allowed");
    expect(reviewRuntimeEnv(HOSTED, { OPENCODE_CONFIG_CONTENT: "{}" })).toBe("env_key_not_allowed");
    expect(reviewRuntimeEnv(HOSTED, { HARNESS_HOME: "x".repeat(MAX_ENV_VALUE_BYTES + 1) })).toBe(
      "env_value_too_long",
    );
    // OpenCode's row has no placeholder: the same key is simply not allowed.
    expect(
      reviewRuntimeEnv(RUNTIME_SPAWN_RULES.opencode as RuntimeSpawnRule, {
        HARNESS_AUTH_TOKEN: RELAY_PLACEHOLDER,
      }),
    ).toBe("env_key_not_allowed");
  });

  it("reviews a start_agent against the row its runtime names", () => {
    expect(reviewRequest(start({ runtime: "opencode" })).kind).toBe("allowed");
    expect(reviewRequest(start({ runtime: "cursor" }))).toEqual({
      kind: "refused",
      denial: "runtime_not_allowed",
    });
  });

  it("parses a start's runtime, and refuses one that is not a string", () => {
    const line = encodeRequest(start({ runtime: "opencode" }));
    expect(parseRequest(line)).toEqual(start({ runtime: "opencode" }));
    const bad = JSON.stringify({ ...start(), runtime: 7 });
    expect(parseRequest(bad)).toBeNull();
    expect(parseRequest(encodeRequest(start()))).toEqual(start());
  });
});

describe("reviewRequest: signal and wait", () => {
  it.each(["SIGTERM", "SIGKILL"] as const)("allows %s and narrows it", (signal) => {
    expect(reviewRequest({ op: "signal", requestId: "r", signal })).toEqual({
      kind: "allowed",
      request: { op: "signal", requestId: "r", signal },
    });
  });

  it.each(["SIGSTOP", "SIGUSR1", "9", "", "sigterm"])("refuses %j", (signal) => {
    expect(reviewRequest({ op: "signal", requestId: "r", signal })).toEqual({
      kind: "refused",
      denial: "signal_not_allowed",
    });
  });

  it("always allows wait", () => {
    expect(reviewRequest({ op: "wait", requestId: "r" })).toEqual({
      kind: "allowed",
      request: { op: "wait", requestId: "r" },
    });
  });
});

describe("reviewRequest: run_check", () => {
  it("allows a check in the workspace, as the agent, writing where its id says", () => {
    expect(reviewRequest(check())).toEqual({ kind: "allowed", request: check() });
  });

  it("allows a check in a base checkout the bridge made", () => {
    expect(reviewRequest(check({ cwd: `${BASE_TREE_ROOT}/run_1` })).kind).toBe("allowed");
  });

  it.each([
    ["an id with a slash", { checkRunId: "../chk" }, "check_id_not_allowed"],
    ["an id with a dot", { checkRunId: "chk.1" }, "check_id_not_allowed"],
    ["an empty id", { checkRunId: "" }, "check_id_not_allowed"],
    ["an id past 128 characters", { checkRunId: "c".repeat(129) }, "check_id_not_allowed"],
    ["the bridge's uid", { uid: 1000 }, "uid_not_allowed"],
    ["root", { uid: 0 }, "uid_not_allowed"],
    ["a cwd in the bridge's home", { cwd: "/opt/oncue" }, "cwd_not_allowed"],
    ["a cwd below the workspace", { cwd: "/workspace/packages/a" }, "cwd_not_allowed"],
    ["the base root itself", { cwd: BASE_TREE_ROOT }, "cwd_not_allowed"],
    ["a base checkout's subdirectory", { cwd: `${BASE_TREE_ROOT}/run_1/src` }, "cwd_not_allowed"],
    ["a base path that climbs out", { cwd: `${BASE_TREE_ROOT}/..` }, "cwd_not_allowed"],
    ["an ONCUE_ key", { env: { ONCUE_SESSION_ID: "s" } }, "env_key_not_allowed"],
    ["a token key", { env: { GITHUB_TOKEN: "t" } }, "env_key_not_allowed"],
    [
      "an env value past the limit",
      { env: { PATH: "a".repeat(64 * 1024 + 1) } },
      "env_value_too_long",
    ],
    [
      "a command past the limit",
      { command: "x".repeat(MAX_CHECK_COMMAND_BYTES + 1) },
      "command_too_long",
    ],
    ["a zero time limit", { timeoutMs: 0 }, "timeout_not_allowed"],
    [
      "a time limit past thirty minutes",
      { timeoutMs: MAX_CHECK_TIMEOUT_MS + 1 },
      "timeout_not_allowed",
    ],
    ["a fractional time limit", { timeoutMs: 1.5 }, "timeout_not_allowed"],
    [
      "output in the bridge's home",
      { outputPath: "/opt/oncue/chk_1.log" },
      "output_path_not_allowed",
    ],
    [
      "output named for another check",
      { outputPath: `${CHECK_OUTPUT_DIR}/chk_2.log` },
      "output_path_not_allowed",
    ],
    ["output in the workspace", { outputPath: "/workspace/chk_1.log" }, "output_path_not_allowed"],
  ] as const)("refuses %s", (_name, overrides, denial) => {
    expect(reviewRequest(check(overrides))).toEqual({ kind: "refused", denial });
  });

  it("measures the command in bytes", () => {
    expect(reviewRequest(check({ command: "a".repeat(MAX_CHECK_COMMAND_BYTES) })).kind).toBe(
      "allowed",
    );
    expect(reviewRequest(check({ command: "é".repeat(MAX_CHECK_COMMAND_BYTES / 2 + 1) }))).toEqual({
      kind: "refused",
      denial: "command_too_long",
    });
  });

  it("names the first wrong thing", () => {
    expect(reviewRequest(check({ uid: 0, cwd: "/", timeoutMs: 0 }))).toEqual({
      kind: "refused",
      denial: "uid_not_allowed",
    });
  });

  it("reviews against the paths it is given, which is how the dev host reuses it", () => {
    const paths: CheckPaths = {
      workspace: "/tmp/dev/workspace",
      baseTreeRoot: "/tmp/dev/base",
      checkOutputDir: "/tmp/dev/checks",
    };
    const local = check({
      cwd: "/tmp/dev/base/run_1",
      outputPath: checkOutputPath("chk_1", paths),
    });
    expect(reviewRunCheck(local, paths)).toBeNull();
    expect(reviewRunCheck(local, SANDBOX_CHECK_PATHS)).toBe("cwd_not_allowed");
    expect(isBaseTreeDir("/tmp/dev/base/run_1", paths)).toBe(true);
  });
});

describe("reviewRequest: signal_check and prepare_base", () => {
  it.each(["SIGTERM", "SIGKILL"] as const)("allows %s to a check", (signal) => {
    expect(
      reviewRequest({ op: "signal_check", requestId: "r", checkRunId: "chk_1", signal }),
    ).toEqual({
      kind: "allowed",
      request: { op: "signal_check", requestId: "r", checkRunId: "chk_1", signal },
    });
  });

  it("refuses any other signal, and a malformed check id first", () => {
    expect(
      reviewRequest({ op: "signal_check", requestId: "r", checkRunId: "chk_1", signal: "SIGSTOP" }),
    ).toEqual({ kind: "refused", denial: "signal_not_allowed" });
    expect(
      reviewRequest({ op: "signal_check", requestId: "r", checkRunId: "a/b", signal: "SIGSTOP" }),
    ).toEqual({ kind: "refused", denial: "check_id_not_allowed" });
  });

  it("allows handing a base checkout to the agent", () => {
    const request: SupervisorRequest = {
      op: "prepare_base",
      requestId: "r",
      dir: `${BASE_TREE_ROOT}/run_1`,
      uid: AGENT_UID,
    };
    expect(reviewRequest(request)).toEqual({ kind: "allowed", request });
  });

  it.each([
    ["the bridge's uid", `${BASE_TREE_ROOT}/run_1`, 1000, "uid_not_allowed"],
    ["the workspace", ALLOWED_CWD, AGENT_UID, "base_dir_not_allowed"],
    ["the bridge's home", "/opt/oncue", AGENT_UID, "base_dir_not_allowed"],
    ["the base root itself", BASE_TREE_ROOT, AGENT_UID, "base_dir_not_allowed"],
    [
      "a climb out of the base root",
      `${BASE_TREE_ROOT}/../checks`,
      AGENT_UID,
      "base_dir_not_allowed",
    ],
    ["a path in /tmp", "/tmp/oncue-base/run_1", AGENT_UID, "base_dir_not_allowed"],
  ] as const)("refuses %s", (_name, dir, uid, denial) => {
    expect(reviewRequest({ op: "prepare_base", requestId: "r", dir, uid })).toEqual({
      kind: "refused",
      denial,
    });
    expect(
      reviewPrepareBase({ op: "prepare_base", requestId: "r", dir, uid }, SANDBOX_CHECK_PATHS),
    ).toBe(denial);
  });
});

describe("reviewRequest: prepare_attachments (composer attachments)", () => {
  it("allows handing a message's attachment directory to the agent", () => {
    const request: SupervisorRequest = {
      op: "prepare_attachments",
      requestId: "r",
      dir: `${ATTACHMENTS_ROOT}/mmsg_1-abc`,
      uid: AGENT_UID,
    };
    expect(reviewRequest(request)).toEqual({ kind: "allowed", request });
  });

  it.each([
    ["the bridge's uid", `${ATTACHMENTS_ROOT}/m1`, 1000, "uid_not_allowed"],
    ["the workspace", ALLOWED_CWD, AGENT_UID, "attachment_dir_not_allowed"],
    ["the attachments root itself", ATTACHMENTS_ROOT, AGENT_UID, "attachment_dir_not_allowed"],
    ["a base checkout", `${BASE_TREE_ROOT}/run_1`, AGENT_UID, "attachment_dir_not_allowed"],
    [
      "a climb out of the root",
      `${ATTACHMENTS_ROOT}/../secrets`,
      AGENT_UID,
      "attachment_dir_not_allowed",
    ],
    ["a nested path", `${ATTACHMENTS_ROOT}/m1/deeper`, AGENT_UID, "attachment_dir_not_allowed"],
  ] as const)("refuses %s", (_name, dir, uid, denial) => {
    expect(reviewRequest({ op: "prepare_attachments", requestId: "r", dir, uid })).toEqual({
      kind: "refused",
      denial,
    });
    expect(
      reviewPrepareAttachments(
        { op: "prepare_attachments", requestId: "r", dir, uid },
        ATTACHMENTS_ROOT,
      ),
    ).toBe(denial);
  });

  it("puts attachments outside every home and the workspace", () => {
    expect(ATTACHMENTS_ROOT).toBe("/var/lib/oncue/attachments");
    expect(isAttachmentDir("/var/lib/oncue/attachments/m1", ATTACHMENTS_ROOT)).toBe(true);
  });
});

describe("the allowlists", () => {
  it("name no key that could carry a credential", () => {
    for (const key of ALLOWED_ENV_KEYS) {
      expect(key).not.toMatch(/^ONCUE_/);
      expect(key).not.toMatch(/TOKEN|KEY$|SECRET|PASSWORD|CREDENTIAL/);
    }
  });

  it("let a check be told it runs under CI, and nothing else the agent is not given", () => {
    expect(CHECK_ENV_KEYS.filter((key) => !ALLOWED_ENV_KEYS.includes(key))).toEqual(["CI"]);
  });

  it("put verification output and base checkouts outside every home and the workspace", () => {
    expect(CHECK_OUTPUT_DIR).toBe("/var/lib/oncue/checks");
    expect(BASE_TREE_ROOT).toBe("/var/lib/oncue/base");
  });

  it("pin the image's values", () => {
    expect(AGENT_UID).toBe(1001);
    expect(ALLOWED_CWD).toBe("/workspace");
    expect(ALLOWED_BINARY).toBe("/opt/opencode/opencode");
  });
});

describe("request framing", () => {
  const requests: SupervisorRequest[] = [
    { op: "chown_workspace", requestId: "a", uid: 1001 },
    start(),
    { op: "signal", requestId: "c", signal: "SIGTERM" },
    { op: "wait", requestId: "d" },
    check(),
    { op: "signal_check", requestId: "e", checkRunId: "chk_1", signal: "SIGKILL" },
    { op: "prepare_base", requestId: "f", dir: `${BASE_TREE_ROOT}/run_1`, uid: AGENT_UID },
    {
      op: "prepare_attachments",
      requestId: "g",
      dir: `${ATTACHMENTS_ROOT}/m1`,
      uid: AGENT_UID,
    },
  ];

  it.each(requests)("round-trips $op", (request) => {
    const line = encodeRequest(request);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseRequest(line.slice(0, -1))).toEqual(request);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a string", '"wait"'],
    ["no requestId", '{"op":"wait"}'],
    ["an empty requestId", '{"op":"wait","requestId":""}'],
    ["a numeric requestId", '{"op":"wait","requestId":1}'],
    ["an op this supervisor does not have", '{"op":"exec","requestId":"r","argv":["sh"]}'],
    ["chown with a fractional uid", '{"op":"chown_workspace","requestId":"r","uid":1001.5}'],
    ["chown with a string uid", '{"op":"chown_workspace","requestId":"r","uid":"1001"}'],
    ["start with an empty argv", JSON.stringify({ ...start(), argv: [] })],
    ["start with a non-string in argv", JSON.stringify({ ...start(), argv: [1] })],
    ["start with a non-string cwd", JSON.stringify({ ...start(), cwd: null })],
    ["start with an array env", JSON.stringify({ ...start(), env: [] })],
    ["start with a non-string env value", JSON.stringify({ ...start(), env: { PATH: 1 } })],
    ["start with a string uid", JSON.stringify({ ...start(), uid: "1001" })],
    ["signal without a signal", '{"op":"signal","requestId":"r"}'],
    ["signal with a numeric signal", '{"op":"signal","requestId":"r","signal":15}'],
    ["a check with an empty command", JSON.stringify({ ...check(), command: "" })],
    ["a check with a numeric id", JSON.stringify({ ...check(), checkRunId: 1 })],
    ["a check with no output path", JSON.stringify({ ...check(), outputPath: undefined })],
    ["a check with an array env", JSON.stringify({ ...check(), env: [] })],
    ["a check with a string time limit", JSON.stringify({ ...check(), timeoutMs: "60000" })],
    ["a check with a string uid", JSON.stringify({ ...check(), uid: "1001" })],
    ["a check with a numeric cwd", JSON.stringify({ ...check(), cwd: 1 })],
    ["signal_check without an id", '{"op":"signal_check","requestId":"r","signal":"SIGTERM"}'],
    ["prepare_base without a dir", '{"op":"prepare_base","requestId":"r","uid":1001}'],
    [
      "prepare_base with a string uid",
      '{"op":"prepare_base","requestId":"r","dir":"/x","uid":"1"}',
    ],
    [
      "prepare_attachments without a dir",
      '{"op":"prepare_attachments","requestId":"r","uid":1001}',
    ],
  ])("rejects %s", (_name, line) => {
    expect(parseRequest(line)).toBeNull();
  });

  it("accepts a signal it will later refuse, so the refusal can say why", () => {
    expect(parseRequest('{"op":"signal","requestId":"r","signal":"SIGSTOP"}')).toEqual({
      op: "signal",
      requestId: "r",
      signal: "SIGSTOP",
    });
  });

  it("recovers the request id of a line it rejected, when there is one", () => {
    expect(requestIdOf('{"op":"exec","requestId":"r9"}')).toBe("r9");
    expect(requestIdOf('{"requestId":9}')).toBe("");
    expect(requestIdOf("nope")).toBe("");
  });
});

describe("response framing", () => {
  const responses: SupervisorResponse[] = [
    { requestId: "a", ok: true, result: { op: "chown_workspace" } },
    { requestId: "b", ok: true, result: { op: "start_agent", pid: 42 } },
    { requestId: "c", ok: true, result: { op: "signal" } },
    { requestId: "d", ok: true, result: { op: "wait", code: 0, signal: null } },
    { requestId: "e", ok: true, result: { op: "wait", code: null, signal: "SIGKILL" } },
    { requestId: "f", ok: false, refusal: { reason: "malformed" } },
    { requestId: "g", ok: false, refusal: { reason: "not_permitted", detail: "uid_not_allowed" } },
    { requestId: "h", ok: false, refusal: { reason: "failed", detail: "EACCES" } },
    { requestId: "i", ok: false, refusal: { reason: "no_such_agent" } },
    { requestId: "j", ok: false, refusal: { reason: "already_running" } },
    {
      requestId: "k",
      ok: true,
      result: {
        op: "run_check",
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 1500,
        outputBytes: 20,
        truncated: false,
      },
    },
    {
      requestId: "l",
      ok: true,
      result: {
        op: "run_check",
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        durationMs: 600000,
        outputBytes: 0,
        truncated: true,
      },
    },
    { requestId: "m", ok: true, result: { op: "signal_check" } },
    { requestId: "n", ok: true, result: { op: "prepare_base" } },
    { requestId: "n2", ok: true, result: { op: "prepare_attachments" } },
    {
      requestId: "n3",
      ok: false,
      refusal: { reason: "not_permitted", detail: "attachment_dir_not_allowed" },
    },
    { requestId: "o", ok: false, refusal: { reason: "no_such_check" } },
    {
      requestId: "p",
      ok: false,
      refusal: { reason: "not_permitted", detail: "output_path_not_allowed" },
    },
  ];

  it.each(responses)("round-trips $requestId", (response) => {
    const line = encodeResponse(response);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseResponse(line.slice(0, -1))).toEqual(response);
  });

  it.each([
    ["not JSON", "nope"],
    ["no requestId", '{"ok":true,"result":{"op":"signal"}}'],
    ["ok that is not a boolean", '{"requestId":"r","ok":"yes"}'],
    ["ok without a result", '{"requestId":"r","ok":true}'],
    ["a result with an unknown op", '{"requestId":"r","ok":true,"result":{"op":"exec"}}'],
    ["start without a pid", '{"requestId":"r","ok":true,"result":{"op":"start_agent"}}'],
    [
      "wait with a string code",
      '{"requestId":"r","ok":true,"result":{"op":"wait","code":"0","signal":null}}',
    ],
    [
      "wait with a numeric signal",
      '{"requestId":"r","ok":true,"result":{"op":"wait","code":null,"signal":9}}',
    ],
    ["a refusal that is not an object", '{"requestId":"r","ok":false,"refusal":"malformed"}'],
    [
      "a refusal with an unknown reason",
      '{"requestId":"r","ok":false,"refusal":{"reason":"tired"}}',
    ],
    [
      "not_permitted with an unknown detail",
      '{"requestId":"r","ok":false,"refusal":{"reason":"not_permitted","detail":"because"}}',
    ],
    ["failed without a detail", '{"requestId":"r","ok":false,"refusal":{"reason":"failed"}}'],
    ...(
      [
        ["a string exit code", { exitCode: "1" }],
        ["a numeric signal", { signal: 9 }],
        ["a non-boolean timedOut", { timedOut: 0 }],
        ["a non-boolean truncated", { truncated: "no" }],
        ["a negative duration", { durationMs: -1 }],
        ["a fractional byte count", { outputBytes: 1.5 }],
      ] as const
    ).map(([name, broken]) => [
      `run_check with ${name}`,
      JSON.stringify({
        requestId: "r",
        ok: true,
        result: {
          op: "run_check",
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1,
          outputBytes: 1,
          truncated: false,
          ...broken,
        },
      }),
    ]),
  ])("rejects %s", (_name, line) => {
    expect(parseResponse(line)).toBeNull();
  });
});

describe("LineSplitter", () => {
  it("joins a line split across chunks and returns only complete lines", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.push(":3}\n")).toEqual(['{"c":3}']);
  });

  it("returns an empty line for a bare newline rather than skipping it", () => {
    expect(new LineSplitter().push("\n")).toEqual([""]);
  });

  it("gives up on a line past the limit and picks up again at the next newline", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("x".repeat(MAX_LINE_BYTES + 1))).toEqual([null]);
    expect(splitter.push("y".repeat(10))).toEqual([]);
    expect(splitter.push('\n{"ok":1}\n')).toEqual(['{"ok":1}']);
  });

  it("discards an overlong line that arrived whole in one chunk", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(`${"x".repeat(MAX_LINE_BYTES + 1)}\nnext\n`)).toEqual([null, "next"]);
  });

  it("reports one overlong line once even when the rest arrives across chunks", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("x".repeat(MAX_LINE_BYTES + 1))).toEqual([null]);
    expect(splitter.push("x".repeat(MAX_LINE_BYTES + 1))).toEqual([]);
    expect(splitter.push("\nafter\n")).toEqual(["after"]);
  });
});

describe("reviewRequest: write_secret and clear_secrets", () => {
  const FAKE_VALUE = "fake-database-url-0001";
  const write = (overrides: Record<string, unknown> = {}): SupervisorRequest =>
    ({
      op: "write_secret",
      requestId: "sec",
      name: "DATABASE_URL",
      value: FAKE_VALUE,
      ...overrides,
    }) as SupervisorRequest;

  it("allows a well-formed name and value, and the clearing of them", () => {
    expect(reviewRequest(write()).kind).toBe("allowed");
    expect(reviewRequest({ op: "clear_secrets", requestId: "clr" }).kind).toBe("allowed");
  });

  it.each([
    "database_url",
    "../../etc/cron.d/x",
    "A/B",
    "",
    "PATH",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "GIT_SSH_COMMAND",
    "ONCUE_BRIDGE_BOOTSTRAP",
    "OPENCODE_CONFIG_CONTENT",
    "CI",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
  ])("refuses the name %j: the bridge is not the control plane, so root checks again", (name) => {
    expect(reviewRequest(write({ name }))).toEqual({
      kind: "refused",
      denial: "secret_name_not_allowed",
    });
  });

  it.each(["short", "fake-value\nSECOND=1", "fake-value\0tail", "x".repeat(40_000)])(
    "refuses the value %#",
    (value) => {
      expect(reviewRequest(write({ value }))).toEqual({
        kind: "refused",
        denial: "secret_value_not_allowed",
      });
    },
  );

  it("names the one file a secret may be written to: a single segment under the root-owned directory", () => {
    expect(SECRETS_DIR).toBe("/var/lib/oncue/secrets");
    expect(secretFilePath("DATABASE_URL")).toBe("/var/lib/oncue/secrets/DATABASE_URL");
  });

  it.each(["secret_name_not_allowed", "secret_value_not_allowed", "too_many_secrets"] as const)(
    "frames a %s refusal, so a request root refuses settles instead of waiting for ever",
    (detail) => {
      const response: SupervisorResponse = {
        requestId: "r",
        ok: false,
        refusal: { reason: "not_permitted", detail },
      };
      expect(parseResponse(encodeResponse(response).trimEnd())).toEqual(response);
    },
  );

  it("frames both requests and their answers, and a refusal never carries the value", () => {
    expect(parseRequest(encodeRequest(write()).trimEnd())).toEqual(write());
    expect(parseRequest(encodeRequest({ op: "clear_secrets", requestId: "c" }).trimEnd())).toEqual({
      op: "clear_secrets",
      requestId: "c",
    });
    expect(
      parseRequest(JSON.stringify({ op: "write_secret", requestId: "s", name: "A" })),
    ).toBeNull();
    expect(
      parseRequest(JSON.stringify({ op: "write_secret", requestId: "s", name: 7, value: "v" })),
    ).toBeNull();
    for (const result of [{ op: "write_secret" }, { op: "clear_secrets" }] as const) {
      const response: SupervisorResponse = { requestId: "r", ok: true, result };
      expect(parseResponse(encodeResponse(response).trimEnd())).toEqual(response);
    }
  });
});

describe("a check's environment and the secret names", () => {
  it("cannot collide: every key a check is given is a name a secret is refused", () => {
    for (const key of CHECK_ENV_KEYS) {
      expect(refuseSecretName(key), key).not.toBeNull();
    }
  });
});
