import { createPublicClient, getAddress, http, zeroAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import type { DexConfig, PoolState, Token } from "../types.js";

const V2_FACTORY_ABI = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    outputs: [{ name: "pair", type: "address" }],
  },
] as const;

const V2_PAIR_ABI = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
] as const;

export async function loadMainnetV2Pools(params: {
  rpcUrl: string;
  dexes: DexConfig[];
  tokens: Token[];
}): Promise<PoolState[]> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(params.rpcUrl),
  });

  const blockNumber = await client.getBlockNumber();
  const pools: PoolState[] = [];

  for (const dex of params.dexes) {
    for (const [tokenA, tokenB] of tokenPairs(params.tokens)) {
      const pair = await client.readContract({
        address: dex.factory,
        abi: V2_FACTORY_ABI,
        functionName: "getPair",
        args: [tokenA.address, tokenB.address],
      });

      if (pair === zeroAddress) {
        continue;
      }

      const [token0Address, token1Address, reserves] = await Promise.all([
        client.readContract({
          address: pair,
          abi: V2_PAIR_ABI,
          functionName: "token0",
        }),
        client.readContract({
          address: pair,
          abi: V2_PAIR_ABI,
          functionName: "token1",
        }),
        client.readContract({
          address: pair,
          abi: V2_PAIR_ABI,
          functionName: "getReserves",
        }),
      ]);

      const token0 = findTokenByAddress(params.tokens, token0Address);
      const token1 = findTokenByAddress(params.tokens, token1Address);
      if (!token0 || !token1) {
        continue;
      }

      pools.push({
        id: getAddress(pair),
        dex,
        token0,
        token1,
        reserve0: reserves[0],
        reserve1: reserves[1],
        blockNumber,
      });
    }
  }

  return pools;
}

function tokenPairs(tokens: Token[]): Array<[Token, Token]> {
  const pairs: Array<[Token, Token]> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      pairs.push([tokens[i], tokens[j]]);
    }
  }
  return pairs;
}

function findTokenByAddress(tokens: Token[], address: Address): Token | undefined {
  const normalized = address.toLowerCase();
  return tokens.find((token) => token.address.toLowerCase() === normalized);
}
