// Vite and Vitest resolve `?raw` imports; this declaration only lets `tsc`
// recognize the specifier.
declare module "*.jsonl?raw" {
  const content: string;
  export default content;
}
