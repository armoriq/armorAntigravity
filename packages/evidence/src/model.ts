// conmap prices a gen_ai.chat span from the LiteLLM table by its gen_ai.request.model, and the SDK
// sets gen_ai.system from the id's prefix, so both need the provider's bare model id. Antigravity
// adds a thinking level to its slugs (`gemini-3.8-flash-high`, https://antigravity.google/docs/cli/headless/)
// and shows display names elsewhere ("Gemini 3.1 Pro (High)", "Claude Sonnet 5.5 (Thinking)").
// Hook payloads carry the slug form in modelName (P0 spike, #5).
const LEVEL_SUFFIX = /-(?:minimal|low|medium|high|thinking)$/;
const DISPLAY_LEVEL = /\s*\((?:minimal|low|medium|high|thinking)\)\s*$/i;

// LiteLLM lists these only under another id (checked against its table on 2026-10-12).
const ALIASES: Readonly<Record<string, string>> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
};

export function canonicalModel(raw: string): string {
  const text = raw.trim().replace(DISPLAY_LEVEL, "");
  if (!text) return "unknown";
  let id = text.toLowerCase().replace(/\s+/g, "-").replace(/^models\//, "").replace(LEVEL_SUFFIX, "");
  // Anthropic ids spell versions with dashes: claude-sonnet-5-5.
  if (id.startsWith("claude-")) id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  return ALIASES[id] ?? id;
}
