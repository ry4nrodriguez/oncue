/**
 * The one export of Pi's `@earendil-works/pi-ai` that OnCue's Pi extension
 * uses (`pi-extension-main.ts`). The package is not a dependency: Pi supplies
 * it to the extensions it loads, and the bundle leaves the import external.
 */
declare module "@earendil-works/pi-ai" {
  export const Type: {
    /** TypeBox 1.x: a JSON Schema taken as a schema type as it stands. */
    Unsafe(schema: unknown): unknown;
  };
}
