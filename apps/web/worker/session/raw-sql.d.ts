// Vite and Vitest resolve `?raw` imports; this only lets `tsc` recognize the specifier.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}

// Duplicates services/bridge/src/raw-fixtures.d.ts: ambient declarations apply
// only within their own program, and this one reaches the bridge transitively.
declare module "*.jsonl?raw" {
  const content: string;
  export default content;
}
