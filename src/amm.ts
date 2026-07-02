import type { CandidateRoute, PoolState, RouteHop, Token } from "./types.js";

export function tokenKey(token: Token): string {
  return token.address.toLowerCase();
}

export function poolKey(pool: PoolState): string {
  return `${pool.dex.id}:${pool.id.toLowerCase()}`;
}

export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return 0n;
  }
  const feeDenominator = 10_000n;
  const amountInWithFee = amountIn * BigInt(10_000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * feeDenominator + amountInWithFee;
  return numerator / denominator;
}

export function reservesFor(pool: PoolState, tokenIn: Token): {
  reserveIn: bigint;
  reserveOut: bigint;
  direction: "zeroToOne" | "oneToZero";
} {
  if (tokenKey(tokenIn) === tokenKey(pool.token0)) {
    return {
      reserveIn: pool.reserve0,
      reserveOut: pool.reserve1,
      direction: "zeroToOne",
    };
  }
  if (tokenKey(tokenIn) === tokenKey(pool.token1)) {
    return {
      reserveIn: pool.reserve1,
      reserveOut: pool.reserve0,
      direction: "oneToZero",
    };
  }
  throw new Error(`Token ${tokenIn.symbol} is not in pool ${pool.id}`);
}

export function simulateRouteExactIn(route: CandidateRoute, amountIn: bigint): bigint {
  let currentAmount = amountIn;
  for (const hop of route.hops) {
    const { reserveIn, reserveOut } = reservesFor(hop.pool, hop.tokenIn);
    currentAmount = getAmountOut(currentAmount, reserveIn, reserveOut, hop.pool.dex.feeBps);
    if (currentAmount <= 0n) {
      return 0n;
    }
  }
  return currentAmount;
}

export function cloneRouteWithPools(route: CandidateRoute): CandidateRoute {
  const poolClones = new Map<string, PoolState>();
  const hops = route.hops.map((hop) => {
    const key = poolKey(hop.pool);
    const existing = poolClones.get(key);
    const pool = existing ?? { ...hop.pool };
    poolClones.set(key, pool);
    return { ...hop, pool };
  });
  return { ...route, hops };
}

export function executeRouteExactIn(route: CandidateRoute, amountIn: bigint): bigint {
  let currentAmount = amountIn;
  for (const hop of route.hops) {
    currentAmount = executeHopExactIn(hop, currentAmount);
    if (currentAmount <= 0n) {
      return 0n;
    }
  }
  return currentAmount;
}

function executeHopExactIn(hop: RouteHop, amountIn: bigint): bigint {
  const { reserveIn, reserveOut, direction } = reservesFor(hop.pool, hop.tokenIn);
  const amountOut = getAmountOut(amountIn, reserveIn, reserveOut, hop.pool.dex.feeBps);
  if (amountOut <= 0n) {
    return 0n;
  }
  if (direction === "zeroToOne") {
    hop.pool.reserve0 += amountIn;
    hop.pool.reserve1 -= amountOut;
  } else {
    hop.pool.reserve1 += amountIn;
    hop.pool.reserve0 -= amountOut;
  }
  return amountOut;
}

export function describeRoute(route: CandidateRoute): string {
  const symbols = [route.hops[0]?.tokenIn.symbol, ...route.hops.map((hop) => hop.tokenOut.symbol)]
    .filter(Boolean)
    .join(" -> ");
  const dexes = route.hops.map((hop) => hop.pool.dex.name).join(" + ");
  return `${symbols} via ${dexes}`;
}
