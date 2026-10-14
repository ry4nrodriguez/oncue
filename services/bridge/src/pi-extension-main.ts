// The entry Pi loads as OnCue's extension (`dist/pi-extension.mjs`, `-e` on Pi's
// command line). It wires TypeBox's `Type` (which Pi supplies to extensions
// through `@earendil-works/pi-ai`, kept external in the bundle), the
// environment, and `fetch` to `pi-extension.ts`.

import { Type } from "@earendil-works/pi-ai";
import { installOnCueExtension, type PiExtensionApi } from "./pi-extension";

export default function oncueExtension(pi: PiExtensionApi): void {
  installOnCueExtension(pi, {
    config: process.env.PI_ONCUE_CONFIG,
    schema: (jsonSchema) => Type.Unsafe(jsonSchema),
    fetch: (url, init) => fetch(url, init),
  });
}
