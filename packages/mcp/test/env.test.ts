// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the literal placeholders Claude Desktop passes are what this tests
import { describe, expect, it } from "vitest";
import { env } from "../src/env.ts";

describe("env", () => {
  it("returns set values and treats empty or unsubstituted extension placeholders as unset", () => {
    const source = { A: "Jan", B: "", C: "${user_config.phone}", D: "call ${user_config.phone} later" };
    expect(env("A", source)).toBe("Jan");
    expect(env("B", source)).toBeUndefined();
    expect(env("C", source)).toBeUndefined();
    expect(env("D", source)).toBe("call ${user_config.phone} later");
    expect(env("MISSING", source)).toBeUndefined();
  });
});
