import { formatUnits, parseUnits } from "viem";
import type { Token } from "./types.js";

export function parseTokenAmount(token: Token, amount: string): bigint {
  return parseUnits(amount, token.decimals);
}

export function formatTokenAmount(token: Token, amount: bigint, digits = 6): string {
  const formatted = formatUnits(amount, token.decimals);
  const [whole, fraction = ""] = formatted.split(".");
  if (fraction.length === 0 || digits <= 0) {
    return whole;
  }
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bpsOf(part: bigint, total: bigint, capBps = 1_000_000): number {
  if (total <= 0n) {
    return capBps;
  }
  const raw = (part * 10_000n) / total;
  const capped = raw > BigInt(capBps) ? BigInt(capBps) : raw;
  return Number(capped);
}

export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

export function sumBigints(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}
