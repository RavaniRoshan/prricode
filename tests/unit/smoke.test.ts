import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("toolchain", () => {
  it("runs vitest on Node 24", () => {
    expect(process.versions.node).toMatch(/^24\./);
  });
  it("provides zod v4 with strictObject", () => {
    const schema = z.strictObject({ a: z.string() });
    expect(schema.parse({ a: "x" })).toEqual({ a: "x" });
    expect(() => schema.parse({ a: "x", b: 1 })).toThrow();
  });
});
