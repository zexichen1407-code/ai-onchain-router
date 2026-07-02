import { applyBps, parseTokenAmount, sumBigints } from "./amounts.js";
import {
  cloneRouteWithPools,
  describeRoute,
  executeRouteExactIn,
  simulateRouteExactIn,
  tokenKey,
} from "./amm.js";
import { netAmountAfterRisk, scoreRoute } from "./risk.js";
import { wrappedTokenFor } from "./config/mainnet.js";
import type {
  CandidateRoute,
  PoolState,
  QuoteRequest,
  RouteAllocation,
  RouteAlternative,
  RouteHop,
  SmartRouteQuote,
  Token,
} from "./types.js";

export function buildSmartRouteQuote(
  tokens: Token[],
  pools: PoolState[],
  request: QuoteRequest,
): SmartRouteQuote {
  const tokenIn = findToken(tokens, request.fromSymbol);
  const tokenOut = findToken(tokens, request.toSymbol);
  const routeTokenIn = wrappedTokenFor(tokenIn, tokens);
  const routeTokenOut = wrappedTokenFor(tokenOut, tokens);
  const amountIn = parseTokenAmount(tokenIn, request.amount);

  if (tokenKey(routeTokenIn) === tokenKey(routeTokenOut)) {
    throw new Error(`No swap route needed from ${tokenIn.symbol} to ${tokenOut.symbol}`);
  }

  const routes = findCandidateRoutes(pools, routeTokenIn, routeTokenOut, request.maxHops, {
    singleRouterOnly: Boolean(request.singleRouterOnly),
  });
  if (routes.length === 0) {
    throw new Error(`No route found from ${tokenIn.symbol} to ${tokenOut.symbol}`);
  }

  const alternatives = routes
    .map((route): RouteAlternative => {
      const amountOut = simulateRouteExactIn(route, amountIn);
      const risk = scoreRoute(route, amountIn);
      return {
        route,
        amountOut,
        risk,
        netAmountOut: netAmountAfterRisk(amountOut, risk),
      };
    })
    .filter((alternative) => alternative.amountOut > 0n)
    .sort((a, b) => compareBigintDesc(a.netAmountOut, b.netAmountOut));

  if (alternatives.length === 0) {
    throw new Error(`Routes exist, but all quoted outputs are zero`);
  }

  const splitPlan = allocateGreedy(alternatives.map((item) => item.route), amountIn, request.maxSplits);
  const allocations = splitPlan
    .filter((allocation) => allocation.amountIn > 0n && allocation.amountOut > 0n)
    .map((allocation): RouteAllocation => {
      const risk = scoreRoute(allocation.route, allocation.amountIn);
      return {
        ...allocation,
        minAmountOut: applyBps(allocation.amountOut, 10_000 - request.slippageBps),
        shareBps: Number((allocation.amountIn * 10_000n) / amountIn),
        risk,
      };
    })
    .sort((a, b) => compareBigintDesc(a.amountOut, b.amountOut));

  const amountOut = sumBigints(allocations.map((allocation) => allocation.amountOut));
  const minAmountOut = sumBigints(allocations.map((allocation) => allocation.minAmountOut));
  const blockNumber = firstBlockNumber(pools);

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    minAmountOut,
    slippageBps: request.slippageBps,
    allocations,
    alternatives: alternatives.slice(0, 8),
    generatedAt: new Date().toISOString(),
    blockNumber,
  };
}

export function findCandidateRoutes(
  pools: PoolState[],
  tokenIn: Token,
  tokenOut: Token,
  maxHops: number,
  options: { singleRouterOnly?: boolean } = {},
): CandidateRoute[] {
  const routes: CandidateRoute[] = [];
  const target = tokenKey(tokenOut);

  function dfs(current: Token, hops: RouteHop[], visitedTokens: Set<string>): void {
    if (hops.length >= maxHops) {
      return;
    }

    for (const pool of pools) {
      const next = otherToken(pool, current);
      if (!next) {
        continue;
      }

      const nextKey = tokenKey(next);
      if (visitedTokens.has(nextKey)) {
        continue;
      }

      const hop: RouteHop = { pool, tokenIn: current, tokenOut: next };
      const nextHops = [...hops, hop];

      if (nextKey === target) {
        const route = {
          id: routeId(nextHops),
          hops: nextHops,
        };
        if (!options.singleRouterOnly || isSingleRouterRoute(route)) {
          routes.push(route);
        }
      } else {
        dfs(next, nextHops, new Set([...visitedTokens, nextKey]));
      }
    }
  }

  dfs(tokenIn, [], new Set([tokenKey(tokenIn)]));
  return dedupeRoutes(routes);
}

export function isSingleRouterRoute(route: CandidateRoute): boolean {
  const firstRouter = route.hops[0]?.pool.dex.router.toLowerCase();
  if (!firstRouter) {
    return false;
  }
  return route.hops.every((hop) => hop.pool.dex.router.toLowerCase() === firstRouter);
}

function allocateGreedy(
  routes: CandidateRoute[],
  totalAmountIn: bigint,
  requestedSplits: number,
): Array<Omit<RouteAllocation, "minAmountOut" | "shareBps" | "risk">> {
  const splitCount = normalizeSplitCount(totalAmountIn, requestedSplits);
  const baseChunk = totalAmountIn / BigInt(splitCount);
  const remainder = totalAmountIn % BigInt(splitCount);

  const states = routes.map((route) => ({
    route: cloneRouteWithPools(route),
    originalRoute: route,
    amountIn: 0n,
    amountOut: 0n,
  }));

  for (let i = 0; i < splitCount; i += 1) {
    const chunk = baseChunk + (BigInt(i) < remainder ? 1n : 0n);
    let bestIndex = -1;
    let bestOutput = 0n;

    for (let j = 0; j < states.length; j += 1) {
      const quoted = simulateRouteExactIn(states[j].route, chunk);
      if (quoted > bestOutput) {
        bestOutput = quoted;
        bestIndex = j;
      }
    }

    if (bestIndex < 0 || bestOutput <= 0n) {
      continue;
    }

    const selected = states[bestIndex];
    const output = executeRouteExactIn(selected.route, chunk);
    selected.amountIn += chunk;
    selected.amountOut += output;
  }

  return states.map((state) => ({
    route: state.originalRoute,
    amountIn: state.amountIn,
    amountOut: state.amountOut,
  }));
}

function normalizeSplitCount(amountIn: bigint, requestedSplits: number): number {
  const sane = Math.max(1, Math.min(32, Math.floor(requestedSplits)));
  return amountIn < BigInt(sane) ? 1 : sane;
}

function findToken(tokens: Token[], symbol: string): Token {
  const token = tokens.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
  if (!token) {
    throw new Error(`Unknown token symbol: ${symbol}`);
  }
  return token;
}

function otherToken(pool: PoolState, token: Token): Token | undefined {
  const key = tokenKey(token);
  if (key === tokenKey(pool.token0)) {
    return pool.token1;
  }
  if (key === tokenKey(pool.token1)) {
    return pool.token0;
  }
  return undefined;
}

function routeId(hops: RouteHop[]): string {
  return hops
    .map((hop) => `${hop.pool.dex.id}:${hop.tokenIn.symbol}-${hop.tokenOut.symbol}:${hop.pool.id}`)
    .join("|");
}

function dedupeRoutes(routes: CandidateRoute[]): CandidateRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const readable = describeRoute(route);
    const key = `${route.id}:${readable}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function compareBigintDesc(a: bigint, b: bigint): number {
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

function firstBlockNumber(pools: PoolState[]): bigint | undefined {
  return pools.find((pool) => pool.blockNumber !== undefined)?.blockNumber;
}
