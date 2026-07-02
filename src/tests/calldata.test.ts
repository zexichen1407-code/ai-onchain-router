import { describe, expect, it } from "vitest";
import { buildDemoPools, DEMO_TOKENS } from "../config/demoPools.js";
import { NATIVE_ETH } from "../config/mainnet.js";
import { buildSmartRouteQuote } from "../router.js";
import { buildSwapCalls } from "../calldata.js";

describe("calldata builder", () => {
  it("encodes Uniswap V2 swapExactTokensForTokens calldata", () => {
    const quote = buildSmartRouteQuote(DEMO_TOKENS, buildDemoPools(), {
      fromSymbol: "USDC",
      toSymbol: "WETH",
      amount: "100",
      slippageBps: 50,
      maxHops: 1,
      maxSplits: 1,
    });
    const calls = buildSwapCalls(
      quote.allocations,
      "0x000000000000000000000000000000000000dEaD",
      1_800_000_000n,
    );

    expect(calls.length).toBe(1);
    expect(calls[0].data.startsWith("0x38ed1739")).toBe(true);
    expect(calls[0].requiresApproval).toBe(true);
    expect(calls[0].value).toBe("0x0");
  });

  it("encodes payable ETH to token swap calldata", () => {
    const quote = buildSmartRouteQuote([NATIVE_ETH, ...DEMO_TOKENS], buildDemoPools(), {
      fromSymbol: "ETH",
      toSymbol: "USDC",
      amount: "0.1",
      slippageBps: 50,
      maxHops: 1,
      maxSplits: 1,
      singleRouterOnly: true,
    });
    const calls = buildSwapCalls(
      quote.allocations,
      "0x000000000000000000000000000000000000dEaD",
      1_800_000_000n,
      { nativeInput: true },
    );

    expect(calls.length).toBe(1);
    expect(calls[0].data.startsWith("0x7ff36ab5")).toBe(true);
    expect(calls[0].requiresApproval).toBe(false);
    expect(calls[0].value).toBe("0x16345785d8a0000");
  });
});
