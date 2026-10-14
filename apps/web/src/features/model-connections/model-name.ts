/**
 * The short name a model id reads as beside its provider's mark: family and
 * version without the release date (`claude-sonnet-4-5-20250929`). An
 * unrecognised id comes back unchanged.
 */
export function displayModelName(modelId: string): string {
  // The minor version is one or two digits and the date exactly eight, so
  // `claude-sonnet-4-20250514` never reads its date as a minor version.
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(modelId);
  if (claude !== null) {
    const family = claude[1] ?? "";
    const major = claude[2] ?? "";
    const minor = claude[3];
    const version = minor === undefined ? major : `${major}.${minor}`;
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`;
  }
  const gpt = /^gpt-(.+)$/.exec(modelId);
  if (gpt !== null) {
    return `GPT-${gpt[1] ?? ""}`;
  }
  return modelId;
}

/**
 * A catalog name as the picker prints it beside the provider's mark, which
 * already names the brand: "Claude Opus 5.5" reads "Opus 5.5". OpenAI names
 * come back unchanged.
 */
export function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/, "");
}
