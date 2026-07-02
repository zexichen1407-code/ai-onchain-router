import { describe, expect, it } from "vitest";
import { buildDemoPools, DEMO_TOKENS } from "../config/demoPools.js";
import { NATIVE_ETH } from "../config/mainnet.js";
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

  it("routes native ETH through WETH pools", () => {
    const quote = buildSmartRouteQuote([NATIVE_ETH, ...DEMO_TOKENS], buildDemoPools(), {
      fromSymbol: "ETH",
      toSymbol: "USDC",
      amount: "0.1",
      slippageBps: 50,
      maxHops: 1,
      maxSplits: 1,
      singleRouterOnly: true,
    });

    expect(quote.tokenIn.symbol).toBe("ETH");
    expect(quote.tokenOut.symbol).toBe("USDC");
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.allocations[0].route.hops[0].tokenIn.symbol).toBe("WETH");
  });
});
