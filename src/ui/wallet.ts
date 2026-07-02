import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  type Address,
  type Hash,
} from "viem";
import { mainnet } from "viem/chains";
import type { SwapCall, Token } from "../types.js";

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WalletConnection {
  provider: EthereumProvider;
  address: Address;
  chainId: number;
}

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function getInjectedProvider(): EthereumProvider {
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No injected wallet found");
  }
  return provider;
}

export async function connectInjectedWallet(): Promise<WalletConnection> {
  const provider = getInjectedProvider();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) {
    throw new Error("Wallet returned no account");
  }
  const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
  return {
    provider,
    address: getAddress(accounts[0]),
    chainId: Number.parseInt(chainIdHex, 16),
  };
}

export async function switchToMainnet(provider: EthereumProvider): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
  } catch (error) {
    const code = getErrorCode(error);
    if (code !== 4902) {
      throw error;
    }
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x1",
          chainName: "Ethereum Mainnet",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://ethereum.publicnode.com"],
          blockExplorerUrls: ["https://etherscan.io"],
        },
      ],
    });
  }
}

export function makePublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
}

export function makeWalletClient(provider: EthereumProvider, account: Address) {
  return createWalletClient({
    account,
    chain: mainnet,
    transport: custom(provider),
  });
}

export async function readAllowance(params: {
  rpcUrl: string;
  token: Token;
  owner: Address;
  spender: Address;
}): Promise<bigint> {
  const publicClient = makePublicClient(params.rpcUrl);
  return publicClient.readContract({
    address: params.token.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [params.owner, params.spender],
  });
}

export async function approveIfNeeded(params: {
  rpcUrl: string;
  provider: EthereumProvider;
  token: Token;
  owner: Address;
  spender: Address;
  amount: bigint;
  onLog: (message: string) => void;
}): Promise<Hash[]> {
  const publicClient = makePublicClient(params.rpcUrl);
  const walletClient = makeWalletClient(params.provider, params.owner);
  const hashes: Hash[] = [];
  const allowance = await publicClient.readContract({
    address: params.token.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [params.owner, params.spender],
  });

  if (allowance >= params.amount) {
    params.onLog(`Allowance ok for ${params.token.symbol}`);
    return hashes;
  }

  if (allowance > 0n) {
    params.onLog(`Resetting ${params.token.symbol} allowance`);
    const resetHash = await walletClient.writeContract({
      address: params.token.address,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [params.spender, 0n],
      account: params.owner,
      chain: mainnet,
    });
    hashes.push(resetHash);
    await publicClient.waitForTransactionReceipt({ hash: resetHash });
  }

  params.onLog(`Approving ${params.token.symbol}`);
  const approveHash = await walletClient.writeContract({
    address: params.token.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [params.spender, params.amount],
    account: params.owner,
    chain: mainnet,
  });
  hashes.push(approveHash);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  return hashes;
}

export async function sendSwapCall(params: {
  rpcUrl: string;
  provider: EthereumProvider;
  owner: Address;
  call: SwapCall;
  onLog: (message: string) => void;
}): Promise<Hash> {
  const publicClient = makePublicClient(params.rpcUrl);
  const walletClient = makeWalletClient(params.provider, params.owner);
  params.onLog(`Sending swap ${shortHash(params.call.routeId)}`);
  const hash = await walletClient.sendTransaction({
    account: params.owner,
    chain: mainnet,
    to: params.call.to,
    data: params.call.data,
    value: 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function etherscanTx(hash: Hash): string {
  return `https://etherscan.io/tx/${hash}`;
}

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function getErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}
