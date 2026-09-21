import { describe, expect, it } from "vitest";
import { activeToolsForBundles } from "../../../src/routing/route-manifest.js";

describe("web search tool preference", () => {
  it("selects Pi-Atlas web_search when it is the available search tool", () => {
    const tools = activeToolsForBundles(
      ["macro"],
      ["get_economic_data", "get_event_probabilities", "get_fear_greed", "web_search"],
    );

    expect(tools).toContain("web_search");
    expect(tools).not.toContain("search_web");
  });

  it("keeps native search_web as the fallback when Atlas is absent", () => {
    const tools = activeToolsForBundles(
      ["macro"],
      ["get_economic_data", "get_event_probabilities", "get_fear_greed", "search_web"],
    );

    expect(tools).toContain("search_web");
    expect(tools).not.toContain("web_search");
  });
});
