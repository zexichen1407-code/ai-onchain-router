import { describe, expect, it } from "vitest";
import { buildDemoPools, DEMO_TOKENS } from "../config/demoPools.js";
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
  });
});
