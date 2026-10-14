import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthGateIdentity, IdentityContext } from "@/features/auth/AuthGate";
import type { ModalConnectionRow } from "@/lib/api/modal-connection";
import { ModalConnectionForm } from "./ModalConnectionForm";
import { ModalConnectionScreen } from "./ModalConnectionScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CONNECTION: ModalConnectionRow = {
  connectionId: "mdl_1",
  workspaceName: "acme-workspace",
  environmentName: null,
  status: "active",
  lastValidatedAt: "2026-09-08T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
};

/** Fills both halves and submits, which is what every save case needs first. */
function fillAndSubmit(options: { tokenId?: string; tokenSecret?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Token ID"), {
    target: { value: options.tokenId ?? "ak-fake0001" },
  });
  fireEvent.change(screen.getByLabelText("Token secret"), {
    target: { value: options.tokenSecret ?? "as-fake0001" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Test and connect/ }));
}

describe("ModalConnectionForm: what it says before the user leaves for Modal", () => {
  // The copy rules from Modal's documentation; a wrong one sends a user to a signup or token they cannot use.
  it("states the plan, the payment method, and the token's authority", () => {
    render(<ModalConnectionForm onSaved={() => {}} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("$30 of compute credit");
    expect(text).toContain("payment method on file");
    expect(text).toContain("full authority over your whole Modal workspace");
    expect(text).toContain("Modal workspace just for OnCue");
  });

  // Modal requires a payment method, so "no credit card" must never appear.
  it("never claims a card is unnecessary", () => {
    render(<ModalConnectionForm onSaved={() => {}} />);

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toContain("no credit card");
    expect(text).not.toContain("without a credit card");
  });

  it("warns that a service user starts with No Access on every Environment", () => {
    render(<ModalConnectionForm onSaved={() => {}} />);

    expect(document.body.textContent).toContain("No Access on every Environment");
  });

  it("links out to where the token pair is created", () => {
    render(<ModalConnectionForm onSaved={() => {}} />);

    const link = screen.getByRole("link", { name: "Create a token pair on Modal" });
    expect(link.getAttribute("href")).toBe("https://modal.com/settings/tokens");
  });

  it("uses no accent colour and no filled or boxed notice", () => {
    const { container } = render(<ModalConnectionForm onSaved={() => {}} />);

    const classes = [...container.querySelectorAll("[class]")]
      .map((element) => element.getAttribute("class") ?? "")
      .join(" ");
    expect(classes).not.toMatch(/\b(text|bg)-accent/);
    expect(classes).not.toMatch(/\bbg-(panel|button|surface)\b/);
    // The storage note is one line of text, not a bordered box.
    const note = screen.getByText(/Stored encrypted and never shown again/);
    expect(note.className).not.toMatch(/\bborder\b/);
  });
});

describe("ModalConnectionForm: saving", () => {
  it("refuses an empty half without sending anything", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<ModalConnectionForm onSaved={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Test and connect/ }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the token ID");

    fireEvent.change(screen.getByLabelText("Token ID"), { target: { value: "ak-fake0001" } });
    fireEvent.click(screen.getByRole("button", { name: /Test and connect/ }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the token secret");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts both halves and the environment, and reports the saved connection", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { connection: { ...CONNECTION, environmentName: "staging" } }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const onSaved = vi.fn();
    render(<ModalConnectionForm onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Environment (optional)"), {
      target: { value: "staging" },
    });
    fillAndSubmit();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0]?.[0]).toEqual({ ...CONNECTION, environmentName: "staging" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      tokenId: "ak-fake0001",
      tokenSecret: "as-fake0001",
      environmentName: "staging",
    });
  });

  it("sends a blank environment as null, which means the workspace default", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { connection: CONNECTION }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    render(<ModalConnectionForm onSaved={() => {}} />);

    fireEvent.change(screen.getByLabelText("Environment (optional)"), { target: { value: "  " } });
    fillAndSubmit();

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).environmentName).toBeNull();
  });

  // A genuine credential with No Access must not read as a rejected token.
  it("names the missing role when the credential can see no Environment", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(422, { error: "test_failed", reason: "no_environment_access" }),
    );
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("No Access on every Environment");
    });
  });

  it("says the credential was not recognized when Modal rejected it", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(422, { error: "test_failed", reason: "invalid_credentials" }),
    );
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("didn't recognize that token pair");
    });
  });

  it("says the problem is OnCue's when the controller could not check", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(503, { error: "test_failed", reason: "controller_unavailable" }),
    );
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("on OnCue's side, not yours");
    });
  });

  it("reports a field the server refused", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(400, { error: "invalid_request", reason: "tokenSecret" }),
    );
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Enter the token secret");
    });
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("couldn't reach the server");
    });
  });

  it("clears both halves once the request resolves, win or lose", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(422, { error: "test_failed", reason: "invalid_credentials" }),
    );
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    // A credential form must not keep the token in React state after submit.
    await waitFor(() => {
      expect((screen.getByLabelText("Token ID") as HTMLInputElement).value).toBe("");
    });
    expect((screen.getByLabelText("Token secret") as HTMLInputElement).value).toBe("");
  });

  it("says it is testing while the round trip is in flight", async () => {
    const deferred = deferredResponse();
    vi.stubGlobal("fetch", () => deferred.promise);
    render(<ModalConnectionForm onSaved={() => {}} />);

    fillAndSubmit();

    await waitFor(() => expect(screen.getByRole("button", { name: "Testing…" })).toBeTruthy());
    deferred.resolve(jsonResponse(200, { connection: CONNECTION }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Test and connect" })).toBeTruthy(),
    );
  });

  it("both halves are masked, because the two are useless apart", () => {
    render(<ModalConnectionForm onSaved={() => {}} />);

    expect(screen.getByLabelText("Token ID").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Token secret").getAttribute("type")).toBe("password");
  });
});

// The screen refreshes the shared identity on disconnect; the tests supply it and count refreshes.
function renderScreen(): { revalidated: () => number } {
  let count = 0;
  const identity: AuthGateIdentity = {
    userId: "user_1",
    workspaceId: "ws_1",
    setup: { kind: "ready", repositories: [], modelConnections: [] },
    revision: 0,
    revalidate: async () => {
      count += 1;
    },
  };
  render(
    <IdentityContext value={identity}>
      <ModalConnectionScreen />
    </IdentityContext>,
  );
  return { revalidated: () => count };
}

describe("ModalConnectionScreen", () => {
  it("shows the connected Modal workspace name back to the user", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { connection: CONNECTION }));
    renderScreen();

    // The workspace name from Modal lets the user check they pasted the right token.
    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
    expect(screen.getByText(/default environment/)).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("names the environment when the connection has one", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { connection: { ...CONNECTION, environmentName: "staging" } }),
    );
    renderScreen();

    await waitFor(() => expect(screen.getByText(/staging/)).toBeTruthy());
  });

  it("shows a connection whose credential has stopped working as not working", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { connection: { ...CONNECTION, status: "invalid" } }),
    );
    renderScreen();

    await waitFor(() => expect(screen.getByText("Not working")).toBeTruthy());
  });

  it("offers the form when nothing is connected", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { connection: null }));
    renderScreen();

    await waitFor(() => expect(screen.getByLabelText("Token ID")).toBeTruthy());
  });

  it("shows the connection once the form saves one", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { connection: null })
        : jsonResponse(200, { connection: CONNECTION });
    });
    renderScreen();

    await waitFor(() => expect(screen.getByLabelText("Token ID")).toBeTruthy());
    fillAndSubmit();

    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
  });

  it("disconnects, then offers the form again", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { connection: CONNECTION })
        : jsonResponse(200, { disconnected: true });
    });
    renderScreen();

    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Disconnect the Modal workspace/ }));

    await waitFor(() => expect(screen.getByLabelText("Token ID")).toBeTruthy());
  });

  // `SetupGate` reads the cached identity, so a disconnect must refresh it or
  // the tab would still say `ready` without a Modal account.
  it("refreshes the identity after a disconnect so the setup gate sees the truth", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { connection: CONNECTION })
        : jsonResponse(200, { disconnected: true });
    });
    const screenState = renderScreen();

    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
    expect(screenState.revalidated()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /Disconnect the Modal workspace/ }));

    await waitFor(() => expect(screenState.revalidated()).toBe(1));
  });

  it("leaves the identity alone when the disconnect failed", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { connection: CONNECTION })
        : jsonResponse(500, { error: "boom" });
    });
    const screenState = renderScreen();

    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Disconnect the Modal workspace/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screenState.revalidated()).toBe(0);
  });

  // A failed disconnect must say so, or the user believes the credential was withdrawn.
  it("says so when a disconnect did not happen", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { connection: CONNECTION })
        : jsonResponse(500, { error: "boom" });
    });
    renderScreen();

    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Disconnect the Modal workspace/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("still in place");
    });
  });

  it("says it is disconnecting while the request is in flight", async () => {
    const deferred = deferredResponse();
    let call = 0;
    vi.stubGlobal("fetch", () => {
      call += 1;
      return call === 1
        ? Promise.resolve(jsonResponse(200, { connection: CONNECTION }))
        : deferred.promise;
    });
    renderScreen();

    await waitFor(() => expect(screen.getByText("acme-workspace")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Disconnect the Modal workspace/ }));

    await waitFor(() => expect(screen.getByText("Disconnecting…")).toBeTruthy());
    deferred.resolve(jsonResponse(200, { disconnected: true }));
    await waitFor(() => expect(screen.getByLabelText("Token ID")).toBeTruthy());
  });

  it("reports a denial", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(403, { error: "not_allowlisted" }));
    renderScreen();

    await waitFor(() => expect(screen.getByText(/don't have access/)).toBeTruthy());
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    renderScreen();

    await waitFor(() =>
      expect(screen.getByText(/couldn't load your Modal connection/)).toBeTruthy(),
    );
  });

  it("says it is loading before the first answer arrives", () => {
    vi.stubGlobal("fetch", () => deferredResponse().promise);
    renderScreen();

    expect(screen.getByText("Loading your Modal connection…")).toBeTruthy();
  });
});
