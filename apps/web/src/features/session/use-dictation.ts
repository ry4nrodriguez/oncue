/**
 * The composer's mic, using the browser's Web Speech API; hidden where the
 * browser has none. OnCue receives no audio: the browser sends it to its own
 * recognition service, and OnCue sees only the text that is sent.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** The part of the Web Speech API used here; the DOM library does not ship its types. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface SpeechResultEvent {
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly 0: { readonly transcript: string };
  }>;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** The browser's recognizer, or null where it has none. */
export function speechRecognitionOf(scope: unknown): SpeechRecognitionConstructor | null {
  if (typeof scope !== "object" || scope === null) {
    return null;
  }
  const holder = scope as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return holder.SpeechRecognition ?? holder.webkitSpeechRecognition ?? null;
}

export type DictationState = "idle" | "listening" | "denied";

export const DICTATION_TOOLTIP =
  "Dictate. Your browser turns your speech into text with its own speech service (in Chrome, Google's). OnCue never receives audio, only the text you send.";
export const DICTATION_DENIED_TOOLTIP =
  "Microphone access is blocked. Allow it for this site in your browser's settings, then try again.";

/** What the words heard so far add to the draft: the final ones, then the interim ones. Pure. */
export function heardText(event: SpeechResultEvent): string {
  let text = "";
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    text += result?.[0].transcript ?? "";
  }
  return text.trim();
}

export interface UseDictation {
  /** False where the browser has no speech recognition: the button is not drawn. */
  readonly supported: boolean;
  readonly state: DictationState;
  toggle(): void;
}

/**
 * `onText` gets the whole draft to show: the text there was when listening
 * started, then what has been heard. `recognizer` is injectable for tests.
 */
export function useDictation(
  currentText: () => string,
  onText: (text: string) => void,
  recognizer: SpeechRecognitionConstructor | null = speechRecognitionOf(
    typeof window === "undefined" ? null : window,
  ),
): UseDictation {
  const [state, setState] = useState<DictationState>("idle");
  const active = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => () => active.current?.stop(), []);

  const toggle = useCallback(() => {
    if (recognizer === null) {
      return;
    }
    if (active.current !== null) {
      active.current.stop();
      return;
    }
    const base = currentText();
    const separator = base.length === 0 || /\s$/.test(base) ? "" : " ";
    const recognition = new recognizer();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = typeof navigator === "undefined" ? "en-US" : navigator.language;
    recognition.onresult = (event) => {
      const heard = heardText(event);
      onText(heard.length === 0 ? base : `${base}${separator}${heard}`);
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setState("denied");
      }
    };
    recognition.onend = () => {
      active.current = null;
      setState((current) => (current === "denied" ? "denied" : "idle"));
    };
    active.current = recognition;
    setState("listening");
    try {
      recognition.start();
    } catch {
      active.current = null;
      setState("idle");
    }
  }, [recognizer, currentText, onText]);

  return { supported: recognizer !== null, state, toggle };
}
