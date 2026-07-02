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

  it("can restrict quotes to routes executable by one router", () => {
    const quote = buildSmartRouteQuote(DEMO_TOKENS, buildDemoPools(), {
      fromSymbol: "USDC",
      toSymbol: "WETH",
      amount: "25000",
      slippageBps: 50,
      maxHops: 2,
      maxSplits: 8,
      singleRouterOnly: true,
    });

    for (const allocation of quote.allocations) {
      const firstRouter = allocation.route.hops[0]?.pool.dex.router.toLowerCase();
      expect(firstRouter).toBeDefined();
      expect(
        allocation.route.hops.every(
          (hop) => hop.pool.dex.router.toLowerCase() === firstRouter,
        ),
      ).toBe(true);
    }
  });
});
