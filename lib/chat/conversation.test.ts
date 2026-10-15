import { describe, expect, it } from "vitest";
import { encodeStreamMeta, splitStreamMeta } from "./conversation";

describe("stream metadata", () => {
  it("returns plain replies untouched", () => {
    expect(splitStreamMeta("Hello there")).toEqual({ content: "Hello there" });
  });

  it("separates the reply from the tools that were used", () => {
    const raw = `Try the fern.${encodeStreamMeta({ toolsUsed: ["search_catalog"] })}`;
    expect(splitStreamMeta(raw)).toEqual({
      content: "Try the fern.",
      meta: { toolsUsed: ["search_catalog"] },
    });
  });

  it("keeps the reply when the trailer is incomplete", () => {
    const raw = `Try the fern.${encodeStreamMeta({ toolsUsed: ["search_catalog"] }).slice(0, 8)}`;
    expect(splitStreamMeta(raw)).toEqual({ content: "Try the fern." });
  });
});
