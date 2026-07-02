import type { DexConfig, Token } from "../types.js";

export const MAINNET_TOKENS: Token[] = [
  {
    symbol: "WETH",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
    chainId: 1,
  },
  {
    symbol: "USDC",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    chainId: 1,
  },
  {
    symbol: "DAI",
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
    chainId: 1,
  },
  {
    symbol: "USDT",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    chainId: 1,
  },
  {
    symbol: "WBTC",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    decimals: 8,
    chainId: 1,
  },
];

export const MAINNET_V2_DEXES: DexConfig[] = [
  {
    id: "uniswap-v2",
    name: "Uniswap V2",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    feeBps: 30,
    baseGas: 110_000,
    gasPerHop: 72_000,
    riskBps: 8,
  },
  {
    id: "sushiswap-v2",
    name: "SushiSwap V2",
    factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    feeBps: 30,
    baseGas: 115_000,
    gasPerHop: 75_000,
    riskBps: 15,
  },
];
