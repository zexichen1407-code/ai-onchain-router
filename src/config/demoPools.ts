import { parseUnits } from "viem";
import { MAINNET_TOKENS, MAINNET_V2_DEXES } from "./mainnet.js";
import type { PoolState, Token } from "../types.js";

const [UNISWAP, SUSHI] = MAINNET_V2_DEXES;

export const DEMO_TOKENS = MAINNET_TOKENS.filter((token) =>
  ["USDC", "WETH", "DAI", "USDT"].includes(token.symbol),
);

export function buildDemoPools(): PoolState[] {
  const usdc = token("USDC");
  const weth = token("WETH");
  const dai = token("DAI");
  const usdt = token("USDT");

  return [
    pool("demo-uni-usdc-weth", UNISWAP, usdc, weth, "3000000", "1000"),
    pool("demo-sushi-usdc-weth", SUSHI, usdc, weth, "850000", "294"),
    pool("demo-uni-usdc-dai", UNISWAP, usdc, dai, "2400000", "2397000"),
    pool("demo-uni-dai-weth", UNISWAP, dai, weth, "1650000", "565"),
    pool("demo-sushi-usdt-weth", SUSHI, usdt, weth, "900000", "306"),
    pool("demo-uni-usdc-usdt", UNISWAP, usdc, usdt, "1800000", "1802000"),
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
  dex: typeof UNISWAP,
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
