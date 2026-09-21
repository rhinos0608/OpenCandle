import { describe, expect, it } from "vitest";
import { buildPiAtlasChildEnv, parsePiAtlasSearchOutput } from "../../../src/providers/pi-atlas.js";

describe("Pi-Atlas search provider", () => {
  it("maps Northstar details results into OpenCandle web evidence", () => {
    const result = parsePiAtlasSearchOutput(
      JSON.stringify({
        ok: true,
        data: {
          details: {
            results: [
              {
                title: "Official release",
                url: "https://www.federalreserve.gov/newsevents/pressreleases/test.htm",
                snippet: "Policy statement",
                source: "exa",
              },
            ],
          },
        },
      }),
      "Fed announcement",
      "news",
    );

    expect(result.provider).toBe("pi-atlas");
    expect(result.results).toEqual([
      expect.objectContaining({
        title: "Official release",
        source: "federalreserve.gov",
        category: "news",
      }),
    ]);
  });

  it("fails closed on a Northstar CLI error envelope", () => {
    expect(() =>
      parsePiAtlasSearchOutput(
        JSON.stringify({ ok: false, error: { code: "tool_error", message: "provider failed" } }),
        "query",
        "general",
      ),
    ).toThrow(/provider failed/);
  });

  it("does not forward unrelated parent secrets to the Northstar child", () => {
    const env = buildPiAtlasChildEnv({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
    });

    expect(env.HOME).toBe("/Users/test");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
