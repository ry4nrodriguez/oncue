import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "./Composer";
import {
  DICTATION_DENIED_TOOLTIP,
  DICTATION_TOOLTIP,
  heardText,
  type SpeechRecognitionLike,
  type SpeechResultEvent,
  speechRecognitionOf,
} from "./use-dictation";

/** A recognizer the test drives: what the browser would hear, and its errors. */
class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null;
  static failStart = false;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: SpeechResultEvent) => void) | null = null;
  onerror: ((event: { readonly error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    if (FakeRecognition.failStart) {
      throw new Error("already started");
    }
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  hear(...results: Array<[string, boolean]>) {
    this.onresult?.({
      results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })),
    });
  }
}

function field(): HTMLTextAreaElement {
  return screen.getByLabelText("Message") as HTMLTextAreaElement;
}

beforeEach(() => {
  window.localStorage.clear();
  FakeRecognition.last = null;
  FakeRecognition.failStart = false;
});

afterEach(() => {
  cleanup();
});

describe("dictation", () => {
  it("is not offered where the browser has no speech recognition", () => {
    render(<Composer sessionId="s" speechRecognition={null} />);
    expect(screen.queryByTestId("composer-dictate")).toBeNull();
  });

  it("writes what it hears after the draft, interim words included, and stops on a second click", () => {
    render(<Composer sessionId="s" speechRecognition={FakeRecognition} />);
    fireEvent.change(field(), { target: { value: "Please" } });
    const mic = screen.getByTestId("composer-dictate");
    expect(mic.getAttribute("title")).toBe(DICTATION_TOOLTIP);
    fireEvent.click(mic);
    const recognition = FakeRecognition.last as FakeRecognition;
    expect(recognition.started).toBe(true);
    expect(recognition.continuous && recognition.interimResults).toBe(true);
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.getAttribute("aria-label")).toBe("Stop dictating");

    act(() => recognition.hear(["fix the", false]));
    expect(field().value).toBe("Please fix the");
    act(() => recognition.hear(["fix the", true], [" failing test", false]));
    expect(field().value).toBe("Please fix the failing test");
    act(() => recognition.hear());
    expect(field().value).toBe("Please");

    fireEvent.click(mic);
    expect(recognition.stopped).toBe(true);
    expect(mic.getAttribute("data-state")).toBe("idle");
  });

  it("starts without a separator on an empty draft or one ending in a space", () => {
    render(<Composer sessionId="s" speechRecognition={FakeRecognition} />);
    fireEvent.click(screen.getByTestId("composer-dictate"));
    act(() => (FakeRecognition.last as FakeRecognition).hear(["hello", true]));
    expect(field().value).toBe("hello");
  });

  it("says when the microphone is blocked, and keeps saying so after the recognizer ends", () => {
    render(<Composer sessionId="s" speechRecognition={FakeRecognition} />);
    const mic = screen.getByTestId("composer-dictate");
    fireEvent.click(mic);
    const recognition = FakeRecognition.last as FakeRecognition;
    act(() => recognition.onerror?.({ error: "not-allowed" }));
    act(() => recognition.onend?.());
    expect(mic.getAttribute("data-state")).toBe("denied");
    expect(mic.getAttribute("title")).toBe(DICTATION_DENIED_TOOLTIP);
    // Any other error is not a refusal.
    fireEvent.click(mic);
    act(() => (FakeRecognition.last as FakeRecognition).onerror?.({ error: "no-speech" }));
    expect(mic.getAttribute("data-state")).toBe("listening");
  });

  it("goes back to idle when the recognizer will not start", () => {
    FakeRecognition.failStart = true;
    render(<Composer sessionId="s" speechRecognition={FakeRecognition} />);
    fireEvent.click(screen.getByTestId("composer-dictate"));
    expect(screen.getByTestId("composer-dictate").getAttribute("data-state")).toBe("idle");
  });
});

describe("speechRecognitionOf and heardText", () => {
  it("finds the standard or the prefixed constructor, and nothing on anything else", () => {
    expect(speechRecognitionOf({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(speechRecognitionOf({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(speechRecognitionOf({})).toBeNull();
    expect(speechRecognitionOf(null)).toBeNull();
  });

  it("joins every result, final and interim, trimmed", () => {
    expect(
      heardText({
        results: [
          { isFinal: true, 0: { transcript: " one" } },
          { isFinal: false, 0: { transcript: " two " } },
        ],
      }),
    ).toBe("one two");
  });
});
