import type { Address, Hex } from "viem";

export interface Token {
  symbol: string;
  address: Address;
  decimals: number;
  chainId: number;
}

export interface DexConfig {
  id: string;
  name: string;
  factory: Address;
  router: Address;
  feeBps: number;
  baseGas: number;
  gasPerHop: number;
  riskBps: number;
}

export interface PoolState {
  id: string;
  dex: DexConfig;
  token0: Token;
  token1: Token;
  reserve0: bigint;
  reserve1: bigint;
  blockNumber?: bigint;
}

export interface RouteHop {
  pool: PoolState;
  tokenIn: Token;
  tokenOut: Token;
}

export interface CandidateRoute {
  id: string;
  hops: RouteHop[];
}

export interface RiskScore {
  penaltyBps: number;
  features: Record<string, number>;
  reasons: string[];
}

export interface RouteAllocation {
  route: CandidateRoute;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  shareBps: number;
  risk: RiskScore;
}

export interface RouteAlternative {
  route: CandidateRoute;
  amountOut: bigint;
  risk: RiskScore;
  netAmountOut: bigint;
}

export interface SmartRouteQuote {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  allocations: RouteAllocation[];
  alternatives: RouteAlternative[];
  generatedAt: string;
  blockNumber?: bigint;
}

export interface QuoteRequest {
  fromSymbol: string;
  toSymbol: string;
  amount: string;
  slippageBps: number;
  maxHops: number;
  maxSplits: number;
  singleRouterOnly?: boolean;
}

export interface SwapCall {
  router: Address;
  to: Address;
  data: Hex;
  value: Hex;
  requiresApproval: boolean;
  routeId: string;
  amountIn: string;
  minAmountOut: string;
}
