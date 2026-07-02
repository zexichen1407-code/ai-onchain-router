import { describe, expect, it } from "vitest";
import { buildDemoPools, DEMO_TOKENS } from "../config/demoPools.js";
import { buildSmartRouteQuote } from "../router.js";

describe("smart route optimizer", () => {
  it("finds a positive route and can split across venues", () => {
    const quote = buildSmartRouteQuote(DEMO_TOKENS, buildDemoPools(), {
      fromSymbol: "USDC",
      toSymbol: "WETH",
      amount: "25000",
      slippageBps: 50,
      maxHops: 2,
      maxSplits: 8,
    });

    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.allocations.length).toBeGreaterThanOrEqual(1);
    expect(quote.alternatives.length).toBeGreaterThanOrEqual(1);
  });
});
