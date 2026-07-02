import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { getAmountOut } from "../amm.js";

describe("AMM math", () => {
  it("quotes Uniswap V2 exact-in output with fee", () => {
    const out = getAmountOut(
      parseUnits("1000", 6),
      parseUnits("3000000", 6),
      parseUnits("1000", 18),
      30,
    );

    expect(out).toBeGreaterThan(parseUnits("0.331", 18));
    expect(out).toBeLessThan(parseUnits("0.333", 18));
  });
});
