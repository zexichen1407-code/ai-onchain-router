import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { buildDemoPools, DEMO_TOKENS } from "../config/demoPools.js";
import { NATIVE_ETH } from "../config/mainnet.js";
import { buildSmartRouteQuote } from "../router.js";
import type { DexConfig, PoolState, Token } from "../types.js";

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

  it("uses AI policy to change route selection", () => {
    const pools = buildPolicyTestPools();
    const maxOutput = buildSmartRouteQuote(DEMO_TOKENS, pools, {
      fromSymbol: "USDC",
      toSymbol: "WETH",
      amount: "1000",
      slippageBps: 50,
      maxHops: 1,
      maxSplits: 1,
      aiPolicy: "max-output",
    });
    const conservative = buildSmartRouteQuote(DEMO_TOKENS, pools, {
      fromSymbol: "USDC",
      toSymbol: "WETH",
      amount: "1000",
      slippageBps: 50,
      maxHops: 1,
      maxSplits: 1,
      aiPolicy: "conservative",
    });

    expect(maxOutput.alternatives[0].route.hops[0].pool.dex.id).toBe("high-output");
    expect(maxOutput.allocations[0].route.hops[0].pool.dex.id).toBe("high-output");
    expect(conservative.alternatives[0].route.hops[0].pool.dex.id).toBe("low-risk");
    expect(conservative.allocations[0].route.hops[0].pool.dex.id).toBe("low-risk");
  });
});

function buildPolicyTestPools(): PoolState[] {
  const usdc = token("USDC");
  const weth = token("WETH");
  const lowRiskDex: DexConfig = {
    id: "low-risk",
    name: "Low Risk DEX",
    factory: "0x0000000000000000000000000000000000000001",
    router: "0x0000000000000000000000000000000000000002",
    feeBps: 30,
    baseGas: 110_000,
    gasPerHop: 72_000,
    riskBps: 0,
  };
  const highOutputDex: DexConfig = {
    id: "high-output",
    name: "High Output DEX",
    factory: "0x0000000000000000000000000000000000000003",
    router: "0x0000000000000000000000000000000000000004",
    feeBps: 30,
    baseGas: 110_000,
    gasPerHop: 72_000,
    riskBps: 900,
  };

  return [
    pool("low-risk-pool", lowRiskDex, usdc, weth, "3000000", "1000"),
    pool("high-output-pool", highOutputDex, usdc, weth, "3000000", "1010"),
  ];
}

function token(symbol: string): Token {
  const found = DEMO_TOKENS.find((item) => item.symbol === symbol);
  if (!found) {
    throw new Error(`Missing demo token ${symbol}`);
  }
  return found;
}

function pool(
  id: string,
  dex: DexConfig,
  token0: Token,
  token1: Token,
  reserve0: string,
  reserve1: string,
): PoolState {
  return {
    id,
    dex,
    token0,
    token1,
    reserve0: parseUnits(reserve0, token0.decimals),
    reserve1: parseUnits(reserve1, token1.decimals),
  };
}
