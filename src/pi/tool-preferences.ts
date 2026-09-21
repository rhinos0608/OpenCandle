const REDUNDANT_WEB_SEARCH_TOOLS = new Set(["search_web", "antigravity_websearch"]);

/**
 * Prefer Pi-Atlas web_search when it is active, while retaining native or
 * provider search tools as fallbacks when Atlas is unavailable or inactive.
 */
export function preferAtlasWebSearchToolNames(
  activeToolNames: readonly string[],
  availableToolNames: readonly string[],
): string[] {
  if (!availableToolNames.includes("web_search") || !activeToolNames.includes("web_search")) {
    return [...activeToolNames];
  }
  return activeToolNames.filter((name) => !REDUNDANT_WEB_SEARCH_TOOLS.has(name));
}
