import "dotenv/config";
import { getAddress, isAddress } from "viem";
import { buildDemoPools, DEMO_TOKENS } from "./config/demoPools.js";
import { MAINNET_TOKENS, MAINNET_V2_DEXES } from "./config/mainnet.js";
import { loadMainnetV2Pools } from "./adapters/onchainV2.js";
import { buildSmartRouteQuote } from "./router.js";
import { buildSwapCalls } from "./calldata.js";
import { describeRoute } from "./amm.js";
import { formatTokenAmount } from "./amounts.js";
import type { PoolState, QuoteRequest, SmartRouteQuote, Token } from "./types.js";

type Args = Record<string, string | boolean>;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const useLive = Boolean(args.live);
  const tokens = useLive ? MAINNET_TOKENS : DEMO_TOKENS;
  const pools = await loadPools(args, useLive, tokens);

  const toAddress = stringArg(args, "to-address", "");
  const request: QuoteRequest = {
    fromSymbol: stringArg(args, "from", "USDC"),
    toSymbol: stringArg(args, "to", "WETH"),
    amount: stringArg(args, "amount", "25000"),
    slippageBps: numberArg(args, "slippage-bps", 50),
    maxHops: numberArg(args, "max-hops", 2),
    maxSplits: numberArg(args, "splits", 8),
    singleRouterOnly: toAddress.length > 0,
  };

  const quote = buildSmartRouteQuote(tokens, pools, request);

  if (Boolean(args.json)) {
    printJson(quote, args);
    return;
  }

  printHuman(quote, useLive ? "live mainnet" : "demo");

  if (toAddress.length > 0) {
    if (!isAddress(toAddress)) {
      throw new Error(`Invalid --to-address: ${toAddress}`);
    }
    const deadlineMinutes = numberArg(args, "deadline-minutes", 20);
    const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + deadlineMinutes * 60);
    const calls = buildSwapCalls(quote.allocations, getAddress(toAddress), deadlineSeconds);
    console.log("\nSwap calldata");
    for (const call of calls) {
      console.log(`- router: ${call.router}`);
      console.log(`  route:  ${call.routeId}`);
      console.log(`  value:  ${call.value}`);
      console.log(`  data:   ${call.data}`);
    }
  } else {
    console.log("\nPass --to-address 0x... to generate swap calldata. Signing and broadcasting are intentionally disabled.");
  }
}

async function loadPools(args: Args, useLive: boolean, tokens: Token[]): Promise<PoolState[]> {
  if (!useLive) {
    return buildDemoPools();
  }
  const rpcUrl = stringArg(args, "rpc", process.env.MAINNET_RPC_URL ?? "");
  if (rpcUrl.length === 0) {
    throw new Error("Live mode needs --rpc or MAINNET_RPC_URL in .env");
  }
  const pools = await loadMainnetV2Pools({
    rpcUrl,
    dexes: MAINNET_V2_DEXES,
    tokens,
  });
  if (pools.length === 0) {
    throw new Error("No on-chain pools loaded. Check RPC URL and token universe.");
  }
  return pools;
}

function printHuman(quote: SmartRouteQuote, mode: string): void {
  console.log(`AI on-chain smart order route (${mode})`);
  if (quote.blockNumber !== undefined) {
    console.log(`block: ${quote.blockNumber.toString()}`);
  }
  console.log(
    `input: ${formatTokenAmount(quote.tokenIn, quote.amountIn)} ${quote.tokenIn.symbol}`,
  );
  console.log(
    `output: ${formatTokenAmount(quote.tokenOut, quote.amountOut)} ${quote.tokenOut.symbol}`,
  );
  console.log(
    `min output @ ${quote.slippageBps} bps slippage: ${formatTokenAmount(
      quote.tokenOut,
      quote.minAmountOut,
    )} ${quote.tokenOut.symbol}`,
  );

  console.log("\nSelected plan");
  for (const allocation of quote.allocations) {
    console.log(`- ${(allocation.shareBps / 100).toFixed(2)}% ${describeRoute(allocation.route)}`);
    console.log(
      `  in/out: ${formatTokenAmount(quote.tokenIn, allocation.amountIn)} ${quote.tokenIn.symbol} -> ${formatTokenAmount(
        quote.tokenOut,
        allocation.amountOut,
      )} ${quote.tokenOut.symbol}`,
    );
    console.log(`  risk penalty: ${allocation.risk.penaltyBps} bps`);
    console.log(`  why: ${allocation.risk.reasons.join("; ")}`);
  }

  console.log("\nTop alternatives");
  for (const alternative of quote.alternatives.slice(0, 5)) {
    console.log(
      `- ${describeRoute(alternative.route)} | out ${formatTokenAmount(
        quote.tokenOut,
        alternative.amountOut,
      )} | net-score ${formatTokenAmount(quote.tokenOut, alternative.netAmountOut)} | risk ${alternative.risk.penaltyBps} bps`,
    );
  }
}

function printJson(quote: SmartRouteQuote, args: Args): void {
  const toAddress = stringArg(args, "to-address", "");
  const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + numberArg(args, "deadline-minutes", 20) * 60);
  const calls =
    toAddress.length > 0 && isAddress(toAddress)
      ? buildSwapCalls(quote.allocations, getAddress(toAddress), deadlineSeconds)
      : [];
  console.log(
    JSON.stringify(
      {
        ...quote,
        amountIn: quote.amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        minAmountOut: quote.minAmountOut.toString(),
        blockNumber: quote.blockNumber?.toString(),
        allocations: quote.allocations.map((allocation) => ({
          ...allocation,
          route: describeRoute(allocation.route),
          amountIn: allocation.amountIn.toString(),
          amountOut: allocation.amountOut.toString(),
          minAmountOut: allocation.minAmountOut.toString(),
        })),
        alternatives: quote.alternatives.map((alternative) => ({
          ...alternative,
          route: describeRoute(alternative.route),
          amountOut: alternative.amountOut.toString(),
          netAmountOut: alternative.netAmountOut.toString(),
        })),
        swapCalls: calls,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function stringArg(args: Args, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function numberArg(args: Args, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
