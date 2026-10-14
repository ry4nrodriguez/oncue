// A double for GitHub's REST API and OAuth token endpoint, used by unit tests
// and local sessions. Only the origin is swapped (`ONCUE_GITHUB_API_ORIGIN`,
// local only), never `worker/github/`'s request shaping. It answers with
// GitHub's own shapes and oddities, never cleaner ones, so tests and the
// double cannot disagree about what GitHub sends; a double replaces GitHub and
// never covers for OnCue's own code.
//
// Requests are recorded as method, path, and header names only; an
// Authorization header is recorded as a boolean. Minted tokens are returned in
// response bodies, as GitHub does, but never recorded.

export interface GitHubDoubleUser {
  readonly id: number;
  readonly login: string;
}

export interface GitHubDoubleInstallation {
  readonly installationId: number;
  readonly account: { readonly login: string; readonly type: "User" | "Organization" };
  readonly appSlug: string;
  /** A spoofed `installation_id` must not appear in `GET /user/installations` for another user. */
  readonly visibleToUserIds: readonly number[];
}

export interface GitHubDoubleRepository {
  readonly id: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  /**
   * GitHub's `clone_url`. The e2e suite seeds a `file://` URL to a real local
   * bare repository so the real bridge's `git clone` can reach it.
   */
  readonly cloneUrl?: string;
}

export interface GitHubDoubleSeed {
  readonly users?: readonly GitHubDoubleUser[];
  readonly installations?: readonly GitHubDoubleInstallation[];
  /** Keyed by `installationId`. */
  readonly repositoriesByInstallation?: Readonly<Record<number, readonly GitHubDoubleRepository[]>>;
  /** Keyed by repository `full_name`, then branch name, to a commit sha. */
  readonly refsByRepository?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Keyed by repository `full_name`: branches a protection rule or ruleset
   * covers, which GitHub reports as `protected: true`.
   */
  readonly protectedBranchesByRepository?: Readonly<Record<string, readonly string[]>>;
  /** Pull requests a person opened before any session, so a session can adopt one. */
  readonly pullRequests?: readonly GitHubDoublePullRequest[];
  /** Keyed by repository `full_name`: rulesets, which the branch API's `protected` flag does not report. */
  readonly rulesetsByRepository?: Readonly<Record<string, readonly GitHubDoubleRuleset[]>>;
  /**
   * Repositories whose plan has no rulesets (a private repository on a free
   * account): both ruleset endpoints answer 403 with GitHub's upgrade sentence.
   */
  readonly rulesetsNotInPlan?: readonly string[];
  /** Single-use OAuth `code` values, mapped to the GitHub user id they resolve to. */
  readonly oauthCodes?: Readonly<Record<string, number>>;
  /**
   * User tokens the double already honours, mapped to their GitHub user id, so
   * a row seeded directly into D1 holds a working token.
   */
  readonly userTokens?: Readonly<Record<string, number>>;
}

/** A ruleset as GitHub's API describes it, flattened to what OnCue reads. */
export interface GitHubDoubleRuleset {
  readonly id: number;
  readonly name: string;
  readonly target: "branch" | "tag";
  readonly enforcement: "active" | "evaluate" | "disabled";
  /** `refs/heads/...` fnmatch patterns, or `~DEFAULT_BRANCH` and `~ALL`. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Rule types, such as `creation`, `update`, `non_fast_forward`, `pull_request`, `required_signatures`. */
  readonly rules: readonly string[];
  /** Where the ruleset lives; an organization's applies to this repository too. */
  readonly source?: "Repository" | "Organization";
}

export type GitHubDoubleMode =
  | "ok"
  | "token_mint_fails"
  | "ref_exists"
  | "revoke_fails"
  /** The App was never granted pull requests: minting a token that asks for them answers 422, as GitHub does. */
  | "pull_requests_not_granted";

/** A pull request as the double holds it. `body` is whatever was last written, so a test can read it back. */
export interface GitHubDoublePullRequest {
  readonly number: number;
  readonly fullName: string;
  title: string;
  readonly head: string;
  readonly base: string;
  readonly headSha: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  body: string;
}

export interface GitHubRecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headerNames: readonly string[];
  readonly hadAuthorization: boolean;
  readonly atMs: number;
  /** Present only for `POST /app/installations/{id}/access_tokens`. */
  readonly tokenNarrowing?: {
    readonly repositoryIds: readonly number[];
    readonly permissions: Readonly<Record<string, string>>;
  };
  /** Present only for `DELETE /installation/token`. */
  readonly tokenRevoked?: boolean;
}

export interface GitHubDouble {
  readonly fetchImpl: typeof fetch;
  /** What arrived, for direct assertions. */
  readonly calls: readonly GitHubRecordedCall[];
  setState(seed: GitHubDoubleSeed): void;
  setMode(mode: GitHubDoubleMode): void;
  /** Every pull request opened so far, oldest first. */
  readonly pullRequests: readonly GitHubDoublePullRequest[];
  /** Points a branch at a commit, as a push does. The HTTP shell calls it with what its real bare repository holds. */
  setRef(fullName: string, branch: string, sha: string): void;
  /** Deletes a branch, as a person does on github.com. */
  deleteRef(fullName: string, branch: string): void;
  /** The branches the double holds for a repository, for the HTTP shell to reconcile with its bare repository. */
  branchNames(fullName: string): readonly string[];
  /** A person adding or removing a protection rule that covers the branch. */
  setProtected(fullName: string, branch: string, isProtected: boolean): void;
  /** A person changing the repository's default branch in its settings. */
  setDefaultBranch(fullName: string, branch: string): void;
  /** A person adding, changing, or removing the repository's rulesets. */
  setRulesets(fullName: string, rulesets: readonly GitHubDoubleRuleset[]): void;
  /**
   * Sets a path in a repository's tree. `ref` is a commit sha, or null for
   * every commit; `text: null` removes it. A `kind` other than `file` answers
   * as GitHub does for a symlink or submodule.
   */
  setFile(
    fullName: string,
    path: string,
    /** Text as UTF-8, or the file's bytes as they are (an image, a binary). */
    text: string | Uint8Array | null,
    options?: { readonly ref?: string | null; readonly kind?: "file" | "symlink" | "submodule" },
  ): void;
  /** A person editing the pull request's description on github.com. */
  editPullRequestBody(number: number, body: string): void;
  /**
   * GitHub's install page: mints a single-use OAuth `code` for the seed's first
   * user and sends them to the App's callback, so a local install completes in
   * a real browser. `null` when the seed has no user or installation.
   */
  install(): { readonly code: string; readonly installationId: number } | null;
}

interface GitHubDoubleState {
  readonly users: Map<number, GitHubDoubleUser>;
  readonly installations: Map<number, GitHubDoubleInstallation>;
  readonly repositoriesByInstallation: Map<number, readonly GitHubDoubleRepository[]>;
  readonly refsByRepository: Map<string, Map<string, string>>;
  readonly protectedBranches: Map<string, Set<string>>;
  /** Overrides the seeded `defaultBranch`, keyed by `fullName`. */
  readonly defaultBranches: Map<string, string>;
  readonly rulesets: Map<string, readonly GitHubDoubleRuleset[]>;
  readonly rulesetsNotInPlan: ReadonlySet<string>;
  /** Keyed by `fullName`, then `path`, then a commit sha or `*`. */
  readonly files: Map<string, { readonly text: string | Uint8Array; readonly kind: string }>;
  readonly pendingOAuthCodes: Map<string, number>;
  readonly issuedInstallationTokens: Set<string>;
  /** What each live installation token was narrowed to, so a route can refuse one that lacks its permission. */
  readonly tokenPermissions: Map<string, Readonly<Record<string, string>>>;
  /** The repositories each installation token reaches, by `fullName`. */
  readonly tokenRepositories: Map<string, ReadonlySet<string>>;
  readonly pullRequests: GitHubDoublePullRequest[];
  readonly userTokens: Map<string, number>;
  readonly refreshTokens: Map<string, number>;
}

function buildState(seed: GitHubDoubleSeed): GitHubDoubleState {
  const repositoriesByInstallation = new Map<number, readonly GitHubDoubleRepository[]>();
  for (const [installationId, repositories] of Object.entries(
    seed.repositoriesByInstallation ?? {},
  )) {
    repositoriesByInstallation.set(Number(installationId), repositories);
  }
  const refsByRepository = new Map<string, Map<string, string>>();
  for (const [fullName, branches] of Object.entries(seed.refsByRepository ?? {})) {
    refsByRepository.set(fullName, new Map(Object.entries(branches)));
  }
  const protectedBranches = new Map<string, Set<string>>();
  for (const [fullName, branches] of Object.entries(seed.protectedBranchesByRepository ?? {})) {
    protectedBranches.set(fullName, new Set(branches));
  }
  return {
    users: new Map((seed.users ?? []).map((user) => [user.id, user])),
    installations: new Map(
      (seed.installations ?? []).map((installation) => [installation.installationId, installation]),
    ),
    repositoriesByInstallation,
    refsByRepository,
    protectedBranches,
    defaultBranches: new Map(),
    rulesets: new Map(Object.entries(seed.rulesetsByRepository ?? {})),
    rulesetsNotInPlan: new Set(seed.rulesetsNotInPlan ?? []),
    files: new Map(),
    pendingOAuthCodes: new Map(Object.entries(seed.oauthCodes ?? {})),
    issuedInstallationTokens: new Set(),
    tokenPermissions: new Map(),
    tokenRepositories: new Map(),
    pullRequests: (seed.pullRequests ?? []).map((pullRequest) => ({ ...pullRequest })),
    userTokens: new Map(Object.entries(seed.userTokens ?? {})),
    refreshTokens: new Map(),
  };
}

export function createGitHubDouble(seed: GitHubDoubleSeed = {}): GitHubDouble {
  let state = buildState(seed);
  let mode: GitHubDoubleMode = "ok";
  const calls: GitHubRecordedCall[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(resolveUrl(input));
    const headers = new Headers(init?.headers);
    const bodyText = await readBodyText(init?.body ?? undefined);
    const outcome = await dispatch(
      method,
      url.pathname,
      headers,
      bodyText,
      state,
      mode,
      url.searchParams,
    );
    // Spreads, because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
    calls.push({
      method,
      path: url.pathname,
      headerNames: [...headers.keys()],
      hadAuthorization: headers.has("authorization"),
      atMs: Date.now(),
      ...(outcome.tokenNarrowing !== undefined ? { tokenNarrowing: outcome.tokenNarrowing } : {}),
      ...(outcome.tokenRevoked !== undefined ? { tokenRevoked: outcome.tokenRevoked } : {}),
    });
    return outcome.response;
  };

  return {
    fetchImpl,
    calls,
    setState(nextSeed) {
      state = buildState(nextSeed);
    },
    get pullRequests() {
      return state.pullRequests;
    },
    setRef(fullName, branch, sha) {
      const refs = state.refsByRepository.get(fullName) ?? new Map<string, string>();
      refs.set(branch, sha);
      state.refsByRepository.set(fullName, refs);
    },
    deleteRef(fullName, branch) {
      state.refsByRepository.get(fullName)?.delete(branch);
    },
    branchNames(fullName) {
      return [...(state.refsByRepository.get(fullName)?.keys() ?? [])];
    },
    setProtected(fullName, branch, isProtected) {
      const branches = state.protectedBranches.get(fullName) ?? new Set<string>();
      if (isProtected) {
        branches.add(branch);
      } else {
        branches.delete(branch);
      }
      state.protectedBranches.set(fullName, branches);
    },
    setDefaultBranch(fullName, branch) {
      state.defaultBranches.set(fullName, branch);
    },
    setRulesets(fullName, rulesets) {
      state.rulesets.set(fullName, rulesets);
    },
    setFile(fullName, path, text, options = {}) {
      const key = fileKey(fullName, path, options.ref ?? null);
      if (text === null) {
        state.files.delete(key);
      } else {
        state.files.set(key, { text, kind: options.kind ?? "file" });
      }
    },
    editPullRequestBody(number, body) {
      const pullRequest = state.pullRequests.find((candidate) => candidate.number === number);
      if (pullRequest !== undefined) {
        pullRequest.body = body;
      }
    },
    install() {
      const user = [...state.users.values()][0];
      if (user === undefined) {
        return null;
      }
      const installation = [...state.installations.values()].find((candidate) =>
        candidate.visibleToUserIds.includes(user.id),
      );
      if (installation === undefined) {
        return null;
      }
      const code = randomToken("code");
      state.pendingOAuthCodes.set(code, user.id);
      return { code, installationId: installation.installationId };
    },
    setMode(nextMode) {
      mode = nextMode;
    },
  };
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function readBodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === null || body === undefined) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return new Response(body).text();
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function parseJson<T>(text: string): T | null {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** GitHub's OAuth token endpoint accepts JSON and form bodies, so the double does too. */
function parseFormOrJsonBody(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = parseJson<Record<string, unknown>>(trimmed) ?? {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  }
  const result: Record<string, string> = {};
  new URLSearchParams(trimmed).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function bearerToken(headers: Headers): string {
  const auth = headers.get("authorization");
  if (auth === null || !auth.startsWith("Bearer ")) {
    return "";
  }
  return auth.slice("Bearer ".length);
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

interface DispatchOutcome {
  readonly response: Response;
  readonly tokenNarrowing?: GitHubRecordedCall["tokenNarrowing"];
  readonly tokenRevoked?: boolean;
}

async function dispatch(
  method: string,
  pathname: string,
  headers: Headers,
  bodyText: string,
  state: GitHubDoubleState,
  mode: GitHubDoubleMode,
  query: URLSearchParams,
): Promise<DispatchOutcome> {
  const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(pathname);
  if (contents !== null && method === "GET") {
    return {
      // The path arrives escaped segment by segment, as GitHub's clients send it.
      response: handleContents(
        contents[1] as string,
        decodeURIComponent(contents[2] as string),
        headers,
        query,
        state,
      ),
    };
  }
  const branchRules = /^\/repos\/([^/]+\/[^/]+)\/rules\/branches\/(.+)$/.exec(pathname);
  if (branchRules !== null && method === "GET") {
    return {
      response: handleBranchRules(
        branchRules[1] as string,
        branchRules[2] as string,
        headers,
        state,
      ),
    };
  }
  const rulesets = /^\/repos\/([^/]+\/[^/]+)\/rulesets(?:\/(\d+))?$/.exec(pathname);
  if (rulesets !== null && method === "GET") {
    return { response: handleRulesets(rulesets[1] as string, rulesets[2], headers, state) };
  }
  const branches = /^\/repos\/([^/]+\/[^/]+)\/branches(?:\/(.+))?$/.exec(pathname);
  if (branches !== null && method === "GET") {
    return {
      response: handleBranches(
        branches[1] as string,
        branches[2] === undefined ? undefined : decodeURIComponent(branches[2]),
        headers,
        query,
        state,
      ),
    };
  }
  const repository = /^\/repos\/([^/]+\/[^/]+)$/.exec(pathname);
  if (repository !== null && method === "GET") {
    return { response: handleGetRepository(repository[1] as string, headers, state) };
  }
  const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?$/.exec(pathname);
  if (pulls !== null) {
    return {
      response: handlePulls(method, pulls[1] as string, pulls[2], headers, bodyText, query, state),
    };
  }
  if (method === "POST") {
    const installationId = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(pathname)?.at(1);
    if (installationId !== undefined) {
      return handleMintToken(installationId, headers, bodyText, state, mode);
    }
  }

  if (method === "DELETE" && pathname === "/installation/token") {
    return handleRevokeToken(headers, state, mode);
  }

  if (method === "POST" && pathname === "/login/oauth/access_token") {
    return { response: handleOAuthExchange(bodyText, state) };
  }

  if (method === "GET" && pathname === "/user") {
    return { response: handleGetUser(headers, state) };
  }

  if (method === "GET" && pathname === "/user/installations") {
    return { response: handleListInstallations(headers, state) };
  }

  if (method === "GET") {
    const repositoriesMatch = /^\/user\/installations\/([^/]+)\/repositories$/
      .exec(pathname)
      ?.at(1);
    if (repositoriesMatch !== undefined) {
      return { response: handleListInstallationRepositories(repositoriesMatch, headers, state) };
    }

    const refMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(pathname);
    const refOwner = refMatch?.at(1);
    const refRepo = refMatch?.at(2);
    const refBranch = refMatch?.at(3);
    if (refOwner !== undefined && refRepo !== undefined && refBranch !== undefined) {
      return { response: handleGetRef(`${refOwner}/${refRepo}`, refBranch, state) };
    }
  }

  if (method === "POST") {
    const createRefMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(pathname);
    const owner = createRefMatch?.at(1);
    const repo = createRefMatch?.at(2);
    if (owner !== undefined && repo !== undefined) {
      return { response: handleCreateRef(`${owner}/${repo}`, bodyText, state, mode) };
    }
  }

  return { response: jsonResponse(404, { message: "Not Found" }) };
}

interface TokenMintRequestBody {
  readonly repository_ids?: readonly number[];
  readonly permissions?: Readonly<Record<string, string>>;
}

function handleMintToken(
  installationIdRaw: string,
  headers: Headers,
  bodyText: string,
  state: GitHubDoubleState,
  mode: GitHubDoubleMode,
): DispatchOutcome {
  const parsed = parseJson<TokenMintRequestBody>(bodyText) ?? {};
  const repositoryIds = parsed.repository_ids ?? [];
  const permissions = parsed.permissions ?? {};
  const tokenNarrowing = { repositoryIds, permissions };

  if (!headers.has("authorization")) {
    return { response: jsonResponse(401, { message: "Bad credentials" }), tokenNarrowing };
  }
  if (mode === "token_mint_fails") {
    return { response: jsonResponse(401, { message: "Bad credentials" }), tokenNarrowing };
  }
  if (mode === "pull_requests_not_granted" && "pull_requests" in permissions) {
    return {
      response: jsonResponse(422, {
        message: "The permissions requested are not granted to this installation.",
      }),
      tokenNarrowing,
    };
  }
  const installationId = Number(installationIdRaw);
  const installation = state.installations.get(installationId);
  if (installation === undefined) {
    return { response: jsonResponse(404, { message: "Not Found" }), tokenNarrowing };
  }

  const repositories = state.repositoriesByInstallation.get(installationId) ?? [];
  // An empty or absent `repository_ids` asks for every repository: the wide
  // token a test must be able to catch, so it is not narrowed here.
  const scoped =
    repositoryIds.length === 0
      ? repositories
      : repositories.filter((repository) => repositoryIds.includes(repository.id));
  const token = randomToken("ghs");
  state.issuedInstallationTokens.add(token);
  state.tokenPermissions.set(token, permissions);
  state.tokenRepositories.set(token, new Set(scoped.map((repository) => repository.fullName)));
  return {
    response: jsonResponse(201, {
      token,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      permissions,
      repositories: scoped.map((repository) => ({
        id: repository.id,
        full_name: repository.fullName,
      })),
    }),
    tokenNarrowing,
  };
}

function handleRevokeToken(
  headers: Headers,
  state: GitHubDoubleState,
  mode: GitHubDoubleMode,
): DispatchOutcome {
  if (!headers.has("authorization")) {
    return { response: jsonResponse(401, { message: "Bad credentials" }), tokenRevoked: false };
  }
  if (mode === "revoke_fails") {
    return { response: jsonResponse(401, { message: "Bad credentials" }), tokenRevoked: false };
  }
  const token = bearerToken(headers);
  if (!state.issuedInstallationTokens.has(token)) {
    return { response: jsonResponse(401, { message: "Bad credentials" }), tokenRevoked: false };
  }
  state.issuedInstallationTokens.delete(token);
  return { response: new Response(null, { status: 204 }), tokenRevoked: true };
}

function mintUserTokenPair(state: GitHubDoubleState, userId: number): Record<string, unknown> {
  const accessToken = randomToken("ghu");
  const refreshToken = randomToken("ghr");
  state.userTokens.set(accessToken, userId);
  state.refreshTokens.set(refreshToken, userId);
  return {
    access_token: accessToken,
    // GitHub App user-to-server tokens: 8 hours, refreshable for 6 months.
    expires_in: 28800,
    refresh_token: refreshToken,
    refresh_token_expires_in: 15897600,
    token_type: "bearer",
  };
}

function handleOAuthExchange(bodyText: string, state: GitHubDoubleState): Response {
  const params = parseFormOrJsonBody(bodyText);
  const grantType = params.grant_type ?? "authorization_code";

  if (grantType === "refresh_token") {
    const refreshToken = params.refresh_token ?? "";
    const userId = state.refreshTokens.get(refreshToken);
    if (userId === undefined) {
      // GitHub's token endpoint answers errors with 200 and an error body.
      return jsonResponse(200, {
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      });
    }
    state.refreshTokens.delete(refreshToken);
    return jsonResponse(200, mintUserTokenPair(state, userId));
  }

  const code = params.code ?? "";
  const userId = state.pendingOAuthCodes.get(code);
  if (userId === undefined) {
    // GitHub really answers an unknown or reused `code` with 200 and an
    // `error` body; this is not a bug in the double.
    return jsonResponse(200, {
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
    });
  }
  state.pendingOAuthCodes.delete(code);
  return jsonResponse(200, mintUserTokenPair(state, userId));
}

function userIdFromAuth(headers: Headers, state: GitHubDoubleState): number | undefined {
  const token = bearerToken(headers);
  if (token === "") {
    return undefined;
  }
  return state.userTokens.get(token);
}

function handleGetUser(headers: Headers, state: GitHubDoubleState): Response {
  const userId = userIdFromAuth(headers, state);
  const user = userId === undefined ? undefined : state.users.get(userId);
  if (user === undefined) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  return jsonResponse(200, { id: user.id, login: user.login });
}

function installationWire(installation: GitHubDoubleInstallation): unknown {
  return {
    id: installation.installationId,
    account: { login: installation.account.login, type: installation.account.type },
    app_slug: installation.appSlug,
  };
}

function handleListInstallations(headers: Headers, state: GitHubDoubleState): Response {
  const userId = userIdFromAuth(headers, state);
  if (userId === undefined) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  const visible = [...state.installations.values()].filter((installation) =>
    installation.visibleToUserIds.includes(userId),
  );
  return jsonResponse(200, {
    total_count: visible.length,
    installations: visible.map(installationWire),
  });
}

function handleListInstallationRepositories(
  installationIdRaw: string,
  headers: Headers,
  state: GitHubDoubleState,
): Response {
  const userId = userIdFromAuth(headers, state);
  if (userId === undefined) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  const installationId = Number(installationIdRaw);
  const installation = state.installations.get(installationId);
  if (installation === undefined || !installation.visibleToUserIds.includes(userId)) {
    // Same status for missing and not-yours, so ids cannot be probed.
    return jsonResponse(404, { message: "Not Found" });
  }
  const repositories = state.repositoriesByInstallation.get(installationId) ?? [];
  return jsonResponse(200, {
    total_count: repositories.length,
    repositories: repositories.map((repository) => ({
      id: repository.id,
      full_name: repository.fullName,
      default_branch: repository.defaultBranch,
      ...(repository.cloneUrl === undefined ? {} : { clone_url: repository.cloneUrl }),
    })),
  });
}

/**
 * A live installation token with `contents` access to this repository, or
 * GitHub's answer to one without: a repository outside the token's narrowing
 * is not found, as GitHub hides it.
 */
function contentsRefusal(
  headers: Headers,
  state: GitHubDoubleState,
  fullName: string,
): Response | null {
  const token = bearerToken(headers);
  if (!state.issuedInstallationTokens.has(token)) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  if (state.tokenRepositories.get(token)?.has(fullName) !== true) {
    return jsonResponse(404, { message: "Not Found" });
  }
  const granted = state.tokenPermissions.get(token)?.contents;
  if (granted !== "read" && granted !== "write") {
    return jsonResponse(403, { message: "Resource not accessible by integration" });
  }
  return null;
}

function findRepository(
  state: GitHubDoubleState,
  fullName: string,
): GitHubDoubleRepository | undefined {
  for (const repositories of state.repositoriesByInstallation.values()) {
    const found = repositories.find((repository) => repository.fullName === fullName);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function branchJson(
  fullName: string,
  name: string,
  sha: string,
  state: GitHubDoubleState,
): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `https://api.github.com/repos/${fullName}/commits/${sha}` },
    protected: state.protectedBranches.get(fullName)?.has(name) === true,
  };
}

/**
 * GitHub's ruleset ref matching, as its documentation describes: fnmatch with
 * `*` and `?` inside one path component, `**` across components, and the
 * `~DEFAULT_BRANCH` and `~ALL` names. Written here as GitHub's behavior, apart
 * from OnCue's own matcher.
 */
function globMatches(pattern: string, text: string): boolean {
  if (pattern.length === 0) {
    return text.length === 0;
  }
  if (pattern.startsWith("**")) {
    for (let cut = 0; cut <= text.length; cut += 1) {
      if (globMatches(pattern.slice(2), text.slice(cut))) {
        return true;
      }
    }
    return false;
  }
  if (pattern.startsWith("*")) {
    for (let cut = 0; cut <= text.length; cut += 1) {
      if (cut > 0 && text[cut - 1] === "/") {
        return false;
      }
      if (globMatches(pattern.slice(1), text.slice(cut))) {
        return true;
      }
    }
    return false;
  }
  if (text.length === 0) {
    return false;
  }
  if (pattern[0] === "?") {
    return text[0] !== "/" && globMatches(pattern.slice(1), text.slice(1));
  }
  return pattern[0] === text[0] && globMatches(pattern.slice(1), text.slice(1));
}

function rulesetApplies(
  ruleset: GitHubDoubleRuleset,
  branch: string,
  defaultBranch: string,
): boolean {
  const ref = `refs/heads/${branch}`;
  const hits = (pattern: string) =>
    pattern === "~ALL" ||
    (pattern === "~DEFAULT_BRANCH" ? branch === defaultBranch : globMatches(pattern, ref));
  return (
    ruleset.target === "branch" &&
    ruleset.enforcement === "active" &&
    ruleset.include.some(hits) &&
    !ruleset.exclude.some(hits)
  );
}

/**
 * A live installation token whose narrowing reaches the repository; rulesets
 * need only metadata access. A plan without rulesets answers as GitHub does.
 */
function metadataRefusal(
  headers: Headers,
  state: GitHubDoubleState,
  fullName: string,
): Response | null {
  const token = bearerToken(headers);
  if (!state.issuedInstallationTokens.has(token)) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  if (state.tokenRepositories.get(token)?.has(fullName) !== true) {
    return jsonResponse(404, { message: "Not Found" });
  }
  if (state.rulesetsNotInPlan.has(fullName)) {
    return jsonResponse(403, {
      message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
      documentation_url: "https://docs.github.com/rest/repos/rules",
      status: "403",
    });
  }
  return null;
}

/** `GET /repos/{owner}/{repo}/rules/branches/{branch}`: every rule of every active ruleset that applies. */
function handleBranchRules(
  fullName: string,
  branch: string,
  headers: Headers,
  state: GitHubDoubleState,
): Response {
  const refused = metadataRefusal(headers, state, fullName);
  if (refused !== null) {
    return refused;
  }
  const repository = findRepository(state, fullName);
  if (repository === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  const defaultBranch = state.defaultBranches.get(fullName) ?? repository.defaultBranch;
  const rules = (state.rulesets.get(fullName) ?? [])
    .filter((ruleset) => rulesetApplies(ruleset, branch, defaultBranch))
    .flatMap((ruleset) =>
      ruleset.rules.map((type) => ({
        type,
        ruleset_source_type: ruleset.source ?? "Repository",
        ruleset_source: ruleset.source === "Organization" ? fullName.split("/")[0] : fullName,
        ruleset_id: ruleset.id,
      })),
    );
  return jsonResponse(200, rules);
}

/** `GET /repos/{owner}/{repo}/rulesets` and `/rulesets/{id}`, with `includes_parents` honored as true. */
function handleRulesets(
  fullName: string,
  idRaw: string | undefined,
  headers: Headers,
  state: GitHubDoubleState,
): Response {
  const refused = metadataRefusal(headers, state, fullName);
  if (refused !== null) {
    return refused;
  }
  if (findRepository(state, fullName) === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  const all = state.rulesets.get(fullName) ?? [];
  const summary = (ruleset: GitHubDoubleRuleset) => ({
    id: ruleset.id,
    name: ruleset.name,
    target: ruleset.target,
    source_type: ruleset.source ?? "Repository",
    source: ruleset.source === "Organization" ? fullName.split("/")[0] : fullName,
    enforcement: ruleset.enforcement,
  });
  if (idRaw === undefined) {
    return jsonResponse(200, all.map(summary));
  }
  const ruleset = all.find((candidate) => candidate.id === Number(idRaw));
  if (ruleset === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  return jsonResponse(200, {
    ...summary(ruleset),
    conditions: { ref_name: { include: ruleset.include, exclude: ruleset.exclude } },
    rules: ruleset.rules.map((type) => ({ type })),
  });
}

/**
 * `GET /repos/{owner}/{repo}/branches` and `/branches/{branch}`, as GitHub
 * answers: 401 without a live installation token, 403 without `contents`,
 * 404 for a missing branch, a list sorted by name in pages of `per_page`
 * (default 30, at most 100) with a `Link` header naming the next page, and
 * `protected` on every branch.
 */
function handleBranches(
  fullName: string,
  branchRaw: string | undefined,
  headers: Headers,
  query: URLSearchParams,
  state: GitHubDoubleState,
): Response {
  const refused = contentsRefusal(headers, state, fullName);
  if (refused !== null) {
    return refused;
  }
  const refs = state.refsByRepository.get(fullName);
  if (findRepository(state, fullName) === undefined || refs === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  if (branchRaw !== undefined) {
    const sha = refs.get(branchRaw);
    if (sha === undefined) {
      return jsonResponse(404, { message: "Branch not found" });
    }
    return jsonResponse(200, branchJson(fullName, branchRaw, sha, state));
  }
  const perPage = Math.min(100, Number(query.get("per_page") ?? "30") || 30);
  const page = Math.max(1, Number(query.get("page") ?? "1") || 1);
  const names = [...refs.keys()].sort();
  const slice = names.slice((page - 1) * perPage, page * perPage);
  const response = jsonResponse(
    200,
    slice.map((name) => branchJson(fullName, name, refs.get(name) as string, state)),
  );
  if (page * perPage < names.length) {
    response.headers.set(
      "link",
      `<https://api.github.com/repos/${fullName}/branches?per_page=${perPage}&page=${page + 1}>; rel="next"`,
    );
  }
  return response;
}

/** `GET /repos/{owner}/{repo}`: the fields OnCue reads, with the default branch as it is now. */
function handleGetRepository(
  fullName: string,
  headers: Headers,
  state: GitHubDoubleState,
): Response {
  const refused = contentsRefusal(headers, state, fullName);
  if (refused !== null) {
    return refused;
  }
  const repository = findRepository(state, fullName);
  if (repository === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  return jsonResponse(200, {
    id: repository.id,
    full_name: repository.fullName,
    default_branch: state.defaultBranches.get(fullName) ?? repository.defaultBranch,
  });
}

function handleGetRef(fullName: string, branch: string, state: GitHubDoubleState): Response {
  const sha = state.refsByRepository.get(fullName)?.get(branch);
  if (sha === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
}

interface PullRequestWriteBody {
  readonly title?: string;
  readonly head?: string;
  readonly base?: string;
  readonly body?: string;
  readonly draft?: boolean;
}

function pullRequestJson(pullRequest: GitHubDoublePullRequest): Record<string, unknown> {
  return {
    number: pullRequest.number,
    html_url: `https://github.com/${pullRequest.fullName}/pull/${pullRequest.number}`,
    title: pullRequest.title,
    body: pullRequest.body,
    draft: pullRequest.draft,
    state: pullRequest.state,
    head: { ref: pullRequest.head, sha: pullRequest.headSha },
    base: { ref: pullRequest.base },
  };
}

function fileKey(fullName: string, path: string, ref: string | null): string {
  return `${fullName}\n${path}\n${ref ?? "*"}`;
}

/**
 * `GET /repos/{owner}/{repo}/contents/{path}?ref=`, as GitHub answers: 401 for
 * an unknown or revoked token, 403 without `contents`, 404 for a missing path,
 * and base64 in 60-character lines. A symlink or submodule has its own `type`
 * and no content; past 1 MiB the content is empty with `encoding: none`; with
 * `Accept: application/vnd.github.raw` the answer is the raw bytes.
 */
function handleContents(
  fullName: string,
  path: string,
  headers: Headers,
  query: URLSearchParams,
  state: GitHubDoubleState,
): Response {
  const token = bearerToken(headers);
  if (!state.issuedInstallationTokens.has(token)) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  const granted = state.tokenPermissions.get(token)?.contents;
  if (granted !== "read" && granted !== "write") {
    return jsonResponse(403, { message: "Resource not accessible by integration" });
  }
  const file =
    state.files.get(fileKey(fullName, path, query.get("ref"))) ??
    state.files.get(fileKey(fullName, path, null));
  if (file === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  if (file.kind !== "file") {
    return jsonResponse(200, { type: file.kind, name: path, path, size: 0 });
  }
  const bytes = typeof file.text === "string" ? new TextEncoder().encode(file.text) : file.text;
  if ((headers.get("accept") ?? "").includes("application/vnd.github.raw")) {
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
    });
  }
  if (bytes.byteLength > 1024 * 1024) {
    // GitHub's own answer past 1 MiB: the size, and no content.
    return jsonResponse(200, {
      type: "file",
      name: path,
      path,
      size: bytes.byteLength,
      encoding: "none",
      content: "",
    });
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return jsonResponse(200, {
    type: "file",
    name: path,
    path,
    size: bytes.byteLength,
    encoding: "base64",
    content: `${(btoa(binary).match(/.{1,60}/g) ?? []).join("\n")}\n`,
  });
}

/**
 * `/repos/{owner}/{repo}/pulls` and `/pulls/{number}`, as GitHub answers: 401
 * without a live installation token, 403 without `pull_requests` access, 422
 * when the head has no commits ahead or a pull request is already open, and a
 * `head.sha` that follows the branch.
 */
function handlePulls(
  method: string,
  fullName: string,
  numberRaw: string | undefined,
  headers: Headers,
  bodyText: string,
  query: URLSearchParams,
  state: GitHubDoubleState,
): Response {
  const token = bearerToken(headers);
  if (!state.issuedInstallationTokens.has(token)) {
    return jsonResponse(401, { message: "Bad credentials" });
  }
  const granted = state.tokenPermissions.get(token)?.pull_requests;
  if (granted !== "write" && !(method === "GET" && granted === "read")) {
    return jsonResponse(403, { message: "Resource not accessible by integration" });
  }
  const refs = state.refsByRepository.get(fullName);
  const open = state.pullRequests.filter(
    (candidate) => candidate.fullName === fullName && candidate.state === "open",
  );
  const follow = (pullRequest: GitHubDoublePullRequest): GitHubDoublePullRequest => ({
    ...pullRequest,
    headSha: refs?.get(pullRequest.head) ?? pullRequest.headSha,
  });
  if (numberRaw === undefined) {
    if (method === "GET") {
      const head = query.get("head");
      const base = query.get("base");
      const owner = fullName.split("/", 1)[0];
      return jsonResponse(
        200,
        open
          .filter((candidate) => head === null || head === `${owner}:${candidate.head}`)
          .filter((candidate) => base === null || base === candidate.base)
          .map((candidate) => pullRequestJson(follow(candidate))),
      );
    }
    if (method !== "POST") {
      return jsonResponse(404, { message: "Not Found" });
    }
    const body = parseJson<PullRequestWriteBody>(bodyText) ?? {};
    const headSha = refs?.get(body.head ?? "");
    const baseSha = refs?.get(body.base ?? "");
    if (body.head === undefined || body.base === undefined || headSha === undefined) {
      return jsonResponse(422, { message: "Validation Failed", errors: [{ field: "head" }] });
    }
    if (headSha === baseSha) {
      return jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ message: `No commits between ${body.base} and ${body.head}` }],
      });
    }
    // GitHub refuses only a second open pull request with the same head AND base.
    if (open.some((candidate) => candidate.head === body.head && candidate.base === body.base)) {
      return jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ message: `A pull request already exists for ${body.head}.` }],
      });
    }
    const created: GitHubDoublePullRequest = {
      number: state.pullRequests.length + 1,
      fullName,
      title: body.title ?? "",
      head: body.head,
      base: body.base,
      headSha,
      draft: body.draft === true,
      state: "open",
      body: body.body ?? "",
    };
    state.pullRequests.push(created);
    return jsonResponse(201, pullRequestJson(created));
  }
  const pullRequest = state.pullRequests.find(
    (candidate) => candidate.fullName === fullName && candidate.number === Number(numberRaw),
  );
  if (pullRequest === undefined) {
    return jsonResponse(404, { message: "Not Found" });
  }
  if (method === "PATCH") {
    const body = parseJson<PullRequestWriteBody>(bodyText) ?? {};
    if (body.title !== undefined) {
      pullRequest.title = body.title;
    }
    if (body.body !== undefined) {
      pullRequest.body = body.body;
    }
  } else if (method !== "GET") {
    return jsonResponse(404, { message: "Not Found" });
  }
  return jsonResponse(200, pullRequestJson(follow(pullRequest)));
}

interface CreateRefRequestBody {
  readonly ref?: string;
  readonly sha?: string;
}

function handleCreateRef(
  fullName: string,
  bodyText: string,
  state: GitHubDoubleState,
  mode: GitHubDoubleMode,
): Response {
  if (mode === "ref_exists") {
    return jsonResponse(422, { message: "Reference already exists" });
  }
  const parsed = parseJson<CreateRefRequestBody>(bodyText) ?? {};
  const refPrefix = "refs/heads/";
  const ref = parsed.ref ?? "";
  const branch = ref.startsWith(refPrefix) ? ref.slice(refPrefix.length) : ref;
  const sha = parsed.sha ?? "";

  let branches = state.refsByRepository.get(fullName);
  if (branches === undefined) {
    branches = new Map();
    state.refsByRepository.set(fullName, branches);
  }
  if (branches.has(branch)) {
    return jsonResponse(422, { message: "Reference already exists" });
  }
  branches.set(branch, sha);
  return jsonResponse(201, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
}

// Webhook helpers, shared by the unit and e2e suites.

/**
 * A real `sha256=<hex>` HMAC-SHA256 over the exact bytes. WebCrypto, so it runs
 * in both workerd and plain Node.
 */
export async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

export interface GitHubAppAuthorizationRevokedPayload {
  readonly action: "revoked";
  readonly sender: { readonly id: number; readonly login: string };
}

export function githubAppAuthorizationRevokedPayload(
  githubUserId: number,
  login: string,
): GitHubAppAuthorizationRevokedPayload {
  return { action: "revoked", sender: { id: githubUserId, login } };
}

export type InstallationWebhookAction = "created" | "deleted" | "suspend" | "unsuspend";

export interface InstallationWebhookPayload {
  readonly action: InstallationWebhookAction;
  readonly installation: {
    readonly id: number;
    readonly account: { readonly login: string; readonly type: "User" | "Organization" };
  };
  readonly sender: { readonly id: number; readonly login: string };
}

export function installationWebhookPayload(
  action: InstallationWebhookAction,
  installationId: number,
  account: { readonly login: string; readonly type: "User" | "Organization" },
  sender: { readonly id: number; readonly login: string },
): InstallationWebhookPayload {
  return { action, installation: { id: installationId, account }, sender };
}

export type InstallationRepositoriesWebhookAction = "added" | "removed";

export interface InstallationRepositoriesWebhookPayload {
  readonly action: InstallationRepositoriesWebhookAction;
  readonly installation: { readonly id: number };
  readonly repositories_added: readonly { readonly id: number; readonly full_name: string }[];
  readonly repositories_removed: readonly { readonly id: number; readonly full_name: string }[];
  readonly sender: { readonly id: number; readonly login: string };
}

/** GitHub always sends both array fields; the one not matching `action` is empty. */
export function installationRepositoriesWebhookPayload(
  action: InstallationRepositoriesWebhookAction,
  installationId: number,
  repositories: readonly { readonly id: number; readonly full_name: string }[],
  sender: { readonly id: number; readonly login: string },
): InstallationRepositoriesWebhookPayload {
  return {
    action,
    installation: { id: installationId },
    repositories_added: action === "added" ? repositories : [],
    repositories_removed: action === "removed" ? repositories : [],
    sender,
  };
}

export interface PushWebhookPayload {
  readonly ref: string;
  readonly before: string;
  readonly after: string;
  readonly repository: {
    readonly id: number;
    readonly full_name: string;
    readonly default_branch: string;
  };
  readonly pusher: { readonly name: string };
  readonly sender: { readonly id: number; readonly login: string };
}

export function pushWebhookPayload(
  repository: { readonly id: number; readonly full_name: string; readonly default_branch: string },
  ref: string,
  beforeSha: string,
  afterSha: string,
  sender: { readonly id: number; readonly login: string },
): PushWebhookPayload {
  return {
    ref,
    before: beforeSha,
    after: afterSha,
    repository,
    pusher: { name: sender.login },
    sender,
  };
}

/**
 * An RSA key for signing test App JWTs, generated at first use because a PEM
 * literal would trip the private-key pattern in `scripts/secret-patterns.mjs`.
 * PKCS#8, the only form `crypto.subtle.importKey` accepts; GitHub issues
 * PKCS#1, which `worker/github/app.ts` converts.
 */
let testPrivateKeyPem: Promise<string> | null = null;

export function githubTestPrivateKeyPem(): Promise<string> {
  testPrivateKeyPem ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
    const bytes = new Uint8Array(pkcs8);
    let raw = "";
    for (const byte of bytes) {
      raw += String.fromCharCode(byte);
    }
    const body = btoa(raw);
    const lines = body.match(/.{1,64}/g) ?? [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  })();
  return testPrivateKeyPem;
}

/**
 * Every setting `readGitHubConfig` requires. Spread it after the Miniflare
 * `env`, which loads `.dev.vars`, so a developer's real App key can never make
 * a test pass.
 */
export async function githubTestSettings(): Promise<Record<string, string>> {
  return {
    ONCUE_GITHUB_APP_SLUG: "oncue-local",
    ONCUE_GITHUB_APP_ID: "1",
    ONCUE_GITHUB_CLIENT_ID: "Iv1.test",
    ONCUE_GITHUB_CLIENT_SECRET: "client-secret",
    ONCUE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
    ONCUE_GITHUB_APP_PRIVATE_KEY: await githubTestPrivateKeyPem(),
  };
}
