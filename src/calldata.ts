import { encodeFunctionData, getAddress, type Address } from "viem";
import type { RouteAllocation, SwapCall, Token } from "./types.js";

const UNISWAP_V2_ROUTER_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

export function buildSwapCalls(
  allocations: RouteAllocation[],
  recipient: Address,
  deadlineSeconds: bigint,
): SwapCall[] {
  return allocations.map((allocation) => {
    const router = allocation.route.hops[0]?.pool.dex.router;
    if (!router) {
      throw new Error(`Cannot build calldata for empty route ${allocation.route.id}`);
    }
    const mixedRouter = allocation.route.hops.some(
      (hop) => hop.pool.dex.router.toLowerCase() !== router.toLowerCase(),
    );
    if (mixedRouter) {
      throw new Error(
        `Route ${allocation.route.id} crosses multiple routers and needs an aggregator contract`,
      );
    }
    const path = routePath(allocation);
    const data = encodeFunctionData({
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [allocation.amountIn, allocation.minAmountOut, path, recipient, deadlineSeconds],
    });

    return {
      router,
      to: router,
      data,
      value: "0x0",
      routeId: allocation.route.id,
      amountIn: allocation.amountIn.toString(),
      minAmountOut: allocation.minAmountOut.toString(),
    };
  });
}

function routePath(allocation: RouteAllocation): Address[] {
  const first = allocation.route.hops[0]?.tokenIn;
  if (!first) {
    throw new Error(`Cannot build path for empty route ${allocation.route.id}`);
  }
  const tokens: Token[] = [first, ...allocation.route.hops.map((hop) => hop.tokenOut)];
  return tokens.map((token) => getAddress(token.address));
}
