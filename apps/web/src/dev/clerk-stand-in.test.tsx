import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClerkProvider,
  LOCAL_SIGN_IN_PATH,
  LOCAL_SIGN_OUT_PATH,
  navigation,
  SignIn,
  SignOutButton,
  useAuth,
  useUser,
} from "./clerk-stand-in";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the stand-in for Clerk's browser SDK", () => {
  it("reports nobody signed in to Clerk, loaded, so the gate shows sign-in at once", () => {
    expect(useAuth()).toEqual({ isLoaded: true, isSignedIn: false });
    expect(useUser()).toEqual({ isLoaded: true, isSignedIn: false, user: null });
  });

  it("renders what it wraps", () => {
    render(
      <ClerkProvider>
        <p>inside</p>
      </ClerkProvider>,
    );
    expect(screen.getByText("inside")).toBeTruthy();
  });

  it("offers the local sign-in where Clerk's form would be", () => {
    render(<SignIn />);
    const link = screen.getByRole("link", { name: "Continue as the local user" });
    expect(link.getAttribute("href")).toBe(LOCAL_SIGN_IN_PATH);
  });

  it("ends the local session when the wrapped control is clicked", () => {
    const go = vi.spyOn(navigation, "go").mockImplementation(() => {});
    render(
      <SignOutButton>
        <button type="button">Sign out</button>
      </SignOutButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(go).toHaveBeenCalledWith(LOCAL_SIGN_OUT_PATH);
  });

  it("passes through anything that is not a single element", () => {
    render(<SignOutButton>plain text</SignOutButton>);
    expect(screen.getByText("plain text")).toBeTruthy();
  });
});
