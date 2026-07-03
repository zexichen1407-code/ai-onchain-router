import { bpsOf } from "./amounts.js";
import { getAmountOut, reservesFor } from "./amm.js";
import type { CandidateRoute, RiskScore } from "./types.js";

export function scoreRoute(route: CandidateRoute, amountIn: bigint): RiskScore {
  let currentAmount = amountIn;
  let maxTradePressureBps = 0;
  let totalDexRiskBps = 0;
  const reasons: string[] = [];

  for (const hop of route.hops) {
    const { reserveIn, reserveOut } = reservesFor(hop.pool, hop.tokenIn);
    const pressure = bpsOf(currentAmount, reserveIn, 1_000_000);
    maxTradePressureBps = Math.max(maxTradePressureBps, pressure);
    totalDexRiskBps += hop.pool.dex.riskBps;
    currentAmount = getAmountOut(currentAmount, reserveIn, reserveOut, hop.pool.dex.feeBps);
  }

  const hopCount = route.hops.length;
  const hopPenaltyBps = Math.max(0, hopCount - 1) * 18;
  const dexRiskBps = Math.round(totalDexRiskBps / Math.max(1, hopCount));
  const liquidityPenaltyBps = Math.min(700, Math.round(maxTradePressureBps * 0.22));
  const penaltyBps = Math.min(2_500, hopPenaltyBps + dexRiskBps + liquidityPenaltyBps);

  if (hopCount > 1) {
    reasons.push(`${hopCount} 跳路线会增加执行复杂度`);
  }
  if (maxTradePressureBps > 300) {
    reasons.push(`最大一跳消耗可见储备的 ${(maxTradePressureBps / 100).toFixed(2)}%`);
  }
  if (dexRiskBps > 0) {
    reasons.push(`DEX 场所风险增加 ${dexRiskBps} 基点`);
  }
  if (reasons.length === 0) {
    reasons.push("可见储备冲击低，执行路径简单");
  }

  return {
    penaltyBps,
    features: {
      hopCount,
      maxTradePressureBps,
      dexRiskBps,
      liquidityPenaltyBps,
      hopPenaltyBps,
    },
    reasons,
  };
}

export function netAmountAfterRisk(amountOut: bigint, risk: RiskScore): bigint {
  return (amountOut * BigInt(10_000 - risk.penaltyBps)) / 10_000n;
}
