import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Play,
  RefreshCw,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { getAddress, isAddress, type Hash } from "viem";
import { loadMainnetV2Pools } from "../adapters/onchainV2.js";
import type { AiAdvisorError, AiAdvisorResponse } from "../aiAdvisor.js";
import { isAiAdvisorResponse } from "../aiAdvisor.js";
import { AI_ROUTING_POLICIES } from "../aiPolicy.js";
import { formatTokenAmount } from "../amounts.js";
import { buildSwapCalls } from "../calldata.js";
import {
  MAINNET_POOL_TOKENS,
  MAINNET_TOKENS,
  MAINNET_V2_DEXES,
  isNativeToken,
} from "../config/mainnet.js";
import { buildSmartRouteQuote } from "../router.js";
import type { AiRoutingPolicyId, SmartRouteQuote } from "../types.js";
import {
  approveIfNeeded,
  connectInjectedWallet,
  etherscanTx,
  makeWalletClient,
  sendSwapCall,
  shortAddress,
  switchToMainnet,
  type WalletConnection,
} from "./wallet.js";

const DEFAULT_RPC = "https://ethereum.publicnode.com";

type BusyState = "idle" | "connect" | "quote" | "sign" | "swap";

interface FormState {
  fromSymbol: string;
  toSymbol: string;
  amount: string;
  slippageBps: string;
  maxHops: string;
  maxSplits: string;
  aiPolicy: AiRoutingPolicyId;
  rpcUrl: string;
}

const initialForm: FormState = {
  fromSymbol: "ETH",
  toSymbol: "USDC",
  amount: "0.05",
  slippageBps: "50",
  maxHops: "2",
  maxSplits: "4",
  aiPolicy: "balanced",
  rpcUrl: DEFAULT_RPC,
};

export default function App() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [quote, setQuote] = useState<SmartRouteQuote | null>(null);
  const [poolCount, setPoolCount] = useState(0);
  const [busy, setBusy] = useState<BusyState>("idle");
  const [status, setStatus] = useState("就绪");
  const [signature, setSignature] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<Hash[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [advisor, setAdvisor] = useState<AiAdvisorResponse | null>(null);
  const [advisorError, setAdvisorError] = useState("");
  const [advisorBusy, setAdvisorBusy] = useState(false);

  const tokenOptions = useMemo(() => MAINNET_TOKENS.map((token) => token.symbol), []);
  const isBusy = busy !== "idle";

  function patchForm(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function log(message: string) {
    setLogs((current) => [`${new Date().toLocaleTimeString()}  ${message}`, ...current].slice(0, 12));
  }

  async function handleConnect() {
    try {
      setBusy("connect");
      const connected = await connectInjectedWallet();
      setWallet(connected);
      setStatus(connected.chainId === 1 ? "钱包已连接" : "网络不正确");
      log(`已连接 ${shortAddress(connected.address)}`);
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSwitchNetwork() {
    if (!wallet) {
      return;
    }
    try {
      setBusy("connect");
      await switchToMainnet(wallet.provider);
      const connected = await connectInjectedWallet();
      setWallet(connected);
      setStatus("以太坊主网已连接");
      log("已切换到以太坊主网");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleQuote() {
    try {
      validateForm(form);
      setBusy("quote");
      setStatus("正在读取池子");
      setQuote(null);
      setAdvisor(null);
      setAdvisorError("");
      setSignature(null);
      setTxHashes([]);
      const pools = await loadMainnetV2Pools({
        rpcUrl: form.rpcUrl.trim(),
        dexes: MAINNET_V2_DEXES,
        tokens: MAINNET_POOL_TOKENS,
      });
      setPoolCount(pools.length);
      const nextQuote = buildSmartRouteQuote(MAINNET_TOKENS, pools, {
        fromSymbol: form.fromSymbol,
        toSymbol: form.toSymbol,
        amount: form.amount,
        slippageBps: Number(form.slippageBps),
        maxHops: Number(form.maxHops),
        maxSplits: Number(form.maxSplits),
        singleRouterOnly: true,
        aiPolicy: form.aiPolicy,
      });
      setQuote(nextQuote);
      setStatus("报价已生成");
      log(`已从 ${pools.length} 个池子生成 ${nextQuote.allocations.length} 个分配方案`);
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSignQuote() {
    if (!wallet || !quote) {
      setStatus("请先连接钱包并生成报价");
      return;
    }
    try {
      setBusy("sign");
      if (wallet.chainId !== 1) {
        await switchToMainnet(wallet.provider);
      }
      const walletClient = makeWalletClient(wallet.provider, wallet.address);
      const signed = await walletClient.signMessage({
        account: wallet.address,
        message: quoteMessage(quote, wallet.address),
      });
      setSignature(signed);
      setStatus("报价已签名");
      log("已获得报价签名");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSwap() {
    if (!wallet || !quote) {
      setStatus("请先连接钱包并生成报价");
      return;
    }
    try {
      setBusy("swap");
      setTxHashes([]);
      if (wallet.chainId !== 1) {
        await switchToMainnet(wallet.provider);
      }
      const recipient = getAddress(wallet.address);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      const nativeInput = isNativeToken(quote.tokenIn);
      const calls = buildSwapCalls(quote.allocations, recipient, deadline, {
        nativeInput,
        nativeOutput: isNativeToken(quote.tokenOut),
      });
      const hashes: Hash[] = [];

      for (let i = 0; i < calls.length; i += 1) {
        const allocation = quote.allocations[i];
        const call = calls[i];
        if (call.requiresApproval && !nativeInput) {
          const approvalHashes = await approveIfNeeded({
            rpcUrl: form.rpcUrl.trim(),
            provider: wallet.provider,
            token: quote.tokenIn,
            owner: wallet.address,
            spender: call.router,
            amount: allocation.amountIn,
            onLog: log,
          });
          hashes.push(...approvalHashes);
          setTxHashes([...hashes]);
        } else {
          log("输入为原生 ETH，已跳过 ERC20 授权");
        }

        const swapHash = await sendSwapCall({
          rpcUrl: form.rpcUrl.trim(),
          provider: wallet.provider,
          owner: wallet.address,
          call,
          onLog: log,
        });
        hashes.push(swapHash);
        setTxHashes([...hashes]);
        log(`兑换已确认 ${shortAddress(swapHash)}`);
      }

      setStatus("兑换已确认");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleAskAiAdvisor() {
    if (!quote) {
      setStatus("请先生成报价");
      return;
    }
    try {
      setAdvisorBusy(true);
      setAdvisor(null);
      setAdvisorError("");
      const response = await fetch("/api/ai-advice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAiAdvisorRequest(quote)),
      });
      const data = (await response.json()) as AiAdvisorResponse | AiAdvisorError;
      if (!response.ok) {
        const message =
          "error" in data
            ? data.setupHint
              ? `${data.error} ${data.setupHint}`
              : data.error
            : "AI 顾问请求失败";
        throw new Error(message);
      }
      if (!isAiAdvisorResponse(data)) {
        throw new Error("AI 顾问返回格式无效");
      }
      setAdvisor(data);
      setStatus("AI 顾问已就绪");
      log(`AI 顾问推荐：${AI_ROUTING_POLICIES[data.recommendedPolicy].label}`);
    } catch (error) {
      const message = errorMessage(error);
      setAdvisorError(message);
      setStatus(message);
    } finally {
      setAdvisorBusy(false);
    }
  }

  function applyAdvisorPolicy() {
    if (!advisor) {
      return;
    }
    patchForm({ aiPolicy: advisor.recommendedPolicy });
    setStatus("已应用 AI 策略，请重新报价");
    log(`已应用 AI 策略：${AI_ROUTING_POLICIES[advisor.recommendedPolicy].label}`);
  }

  async function copySignature() {
    if (!signature) {
      return;
    }
    await navigator.clipboard.writeText(signature);
    log("签名已复制");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">以太坊主网</p>
          <h1>AI 链上订单路由</h1>
        </div>
        <div className="wallet-stack">
          {wallet ? (
            <div className="wallet-chip">
              <Wallet size={16} />
              <span>{shortAddress(wallet.address)}</span>
              <span className={wallet.chainId === 1 ? "chain-ok" : "chain-bad"}>
                {wallet.chainId === 1 ? "主网" : `链 ID ${wallet.chainId}`}
              </span>
            </div>
          ) : null}
          {wallet && wallet.chainId !== 1 ? (
            <button className="secondary-button" onClick={handleSwitchNetwork} disabled={isBusy}>
              <RefreshCw size={16} />
              切换网络
            </button>
          ) : (
            <button className="primary-button" onClick={handleConnect} disabled={isBusy}>
              <Wallet size={16} />
              {wallet ? "重新连接" : "连接钱包"}
            </button>
          )}
        </div>
      </header>

      <section className="status-row">
        <div className="status-pill">
          {isPositiveStatus(status) ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <span>{status}</span>
        </div>
        <span>{poolCount > 0 ? `已加载 ${poolCount} 个池子` : "尚未加载池子"}</span>
      </section>

      <section className="workspace-grid">
        <form className="panel order-panel" onSubmit={(event) => event.preventDefault()}>
          <div className="panel-heading">
            <Route size={18} />
            <h2>订单</h2>
          </div>

          <label>
            <span>卖出</span>
            <select
              value={form.fromSymbol}
              onChange={(event) => patchForm({ fromSymbol: event.target.value })}
            >
              {tokenOptions.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>买入</span>
            <select
              value={form.toSymbol}
              onChange={(event) => patchForm({ toSymbol: event.target.value })}
            >
              {tokenOptions.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>数量</span>
            <input
              value={form.amount}
              inputMode="decimal"
              onChange={(event) => patchForm({ amount: event.target.value })}
            />
          </label>

          <div className="field-row">
            <label>
              <span>滑点基点</span>
              <input
                value={form.slippageBps}
                inputMode="numeric"
                onChange={(event) => patchForm({ slippageBps: event.target.value })}
              />
            </label>
            <label>
              <span>拆单数</span>
              <input
                value={form.maxSplits}
                inputMode="numeric"
                onChange={(event) => patchForm({ maxSplits: event.target.value })}
              />
            </label>
          </div>

          <label>
            <span>最大跳数</span>
            <select value={form.maxHops} onChange={(event) => patchForm({ maxHops: event.target.value })}>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </label>

          <label>
            <span>AI 策略</span>
            <select
              value={form.aiPolicy}
              onChange={(event) =>
                patchForm({ aiPolicy: event.target.value as AiRoutingPolicyId })
              }
            >
              {Object.values(AI_ROUTING_POLICIES).map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>RPC</span>
            <input value={form.rpcUrl} onChange={(event) => patchForm({ rpcUrl: event.target.value })} />
          </label>

          <button className="primary-button full-width" onClick={handleQuote} disabled={isBusy}>
            <RefreshCw size={16} className={busy === "quote" ? "spin" : ""} />
            获取报价
          </button>
        </form>

        <section className="panel route-panel">
          <div className="panel-heading">
            <ShieldCheck size={18} />
            <h2>路线</h2>
          </div>

          {quote ? (
            <>
              <div className="quote-summary">
                <div>
                  <span>输入</span>
                  <strong>
                    {formatTokenAmount(quote.tokenIn, quote.amountIn)} {quote.tokenIn.symbol}
                  </strong>
                </div>
                <div>
                  <span>输出</span>
                  <strong>
                    {formatTokenAmount(quote.tokenOut, quote.amountOut)} {quote.tokenOut.symbol}
                  </strong>
                </div>
                <div>
                  <span>最低到账</span>
                  <strong>
                    {formatTokenAmount(quote.tokenOut, quote.minAmountOut)} {quote.tokenOut.symbol}
                  </strong>
                </div>
                <div>
                  <span>区块</span>
                  <strong>{quote.blockNumber?.toString() ?? "-"}</strong>
                </div>
              </div>

              <div className="allocation-list">
                {quote.allocations.map((allocation) => (
                  <article className="allocation-card" key={allocation.route.id}>
                    <div>
                      <h3>{describeDisplayRoute(quote, allocation.route)}</h3>
                      <p>{allocation.risk.reasons.join("; ")}</p>
                    </div>
                    <div className="allocation-meta">
                      <span>{(allocation.shareBps / 100).toFixed(2)}%</span>
                      <strong>
                        {formatTokenAmount(quote.tokenOut, allocation.amountOut)} {quote.tokenOut.symbol}
                      </strong>
                      <em>{allocation.risk.penaltyBps} bps</em>
                    </div>
                  </article>
                ))}
              </div>

              <section className="ai-analysis">
                <div className="analysis-heading">
                  <div>
                    <span>AI 分析</span>
                    <h3>{buildDecisionSummary(quote)}</h3>
                  </div>
                  <Sparkles size={18} />
                </div>

                <p className="analysis-formula">
                  {quote.aiPolicy.label}：AI 分数 = 预期输出 x (10000 - AI 惩罚基点) / 10000
                </p>
                <p className="analysis-policy-copy">{quote.aiPolicy.description}</p>

                <div className="analysis-metrics">
                  {analysisMetrics(quote).map((metric) => (
                    <div key={metric.label}>
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="analysis-ranking">
                  {quote.alternatives.slice(0, 5).map((alternative, index) => (
                    <article
                      className={index === 0 ? "analysis-row selected" : "analysis-row"}
                      key={alternative.route.id}
                    >
                      <div className="rank-index">{index + 1}</div>
                      <div className="rank-body">
                        <div className="rank-title">
                          <strong>{describeDisplayRoute(quote, alternative.route)}</strong>
                          <span>{index === 0 ? "已选择" : "候选"}</span>
                        </div>
                        <div className="rank-grid">
                          <span>
                            预期输出 {formatTokenAmount(quote.tokenOut, alternative.amountOut)}{" "}
                            {quote.tokenOut.symbol}
                          </span>
                          <span>
                            AI 分数 {formatTokenAmount(quote.tokenOut, alternative.netAmountOut)}{" "}
                            {quote.tokenOut.symbol}
                          </span>
                          <span>AI 惩罚 {alternative.aiScore.penaltyBps} 基点</span>
                          <span>池子冲击 {formatBps(alternative.risk.features.maxTradePressureBps)}</span>
                        </div>
                        <p>{alternative.aiScore.reasons.join("; ")}</p>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="llm-advisor">
                  <div className="advisor-action-row">
                    <div>
                      <span>大模型顾问</span>
                      <strong>Cloudflare Workers AI 正在复核候选路线</strong>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={handleAskAiAdvisor}
                      disabled={advisorBusy || !quote}
                    >
                      <Sparkles size={16} className={advisorBusy ? "spin" : ""} />
                      询问 AI 顾问
                    </button>
                  </div>

                  {advisorError ? <p className="advisor-error">{advisorError}</p> : null}

                  {advisor ? (
                    <div className="advisor-result">
                      <div className="advisor-summary">
                        <div>
                          <span>推荐策略</span>
                          <strong>{AI_ROUTING_POLICIES[advisor.recommendedPolicy].label}</strong>
                        </div>
                        <div>
                          <span>信心</span>
                          <strong>{Math.round(advisor.confidence * 100)}%</strong>
                        </div>
                      </div>
                      <div className="advisor-list">
                        <span>AI 额外贡献</span>
                        <p>{advisor.aiContribution}</p>
                      </div>
                      <div className={`execution-gate ${advisor.executionGate.decision}`}>
                        <div>
                          <span>AI 执行闸门</span>
                          <strong>{formatExecutionDecision(advisor.executionGate.decision)}</strong>
                        </div>
                        <p>{advisor.executionGate.reason}</p>
                        <em>建议滑点：{advisor.executionGate.suggestedSlippageBps} 基点</em>
                        {advisor.executionGate.mustCheck.map((item) => (
                          <small key={item}>{item}</small>
                        ))}
                      </div>
                      <p>{advisor.thesis}</p>
                      <div className="scenario-grid">
                        {advisor.scenarios.map((scenario) => (
                          <article key={`${scenario.scenario}-${scenario.preferredRouteId}`}>
                            <div>
                              <span>{formatSeverity(scenario.severity)}</span>
                              <strong>{scenario.scenario}</strong>
                            </div>
                            <p>{scenario.impact}</p>
                            <em>{scenario.action}</em>
                            <small>该场景偏好：{routeNameForId(quote, scenario.preferredRouteId)}</small>
                          </article>
                        ))}
                      </div>
                      <div className="advisor-notes">
                        {advisor.routeNotes.slice(0, 4).map((note) => (
                          <article key={`${note.routeId}-${note.verdict}`}>
                            <span>{formatAdvisorVerdict(note.verdict)}</span>
                            <strong>{routeNameForId(quote, note.routeId)}</strong>
                            <p>{note.reason}</p>
                          </article>
                        ))}
                      </div>
                      {advisor.warnings.length > 0 ? (
                        <div className="advisor-list">
                          <span>风险提示</span>
                          {advisor.warnings.map((item) => (
                            <p key={item}>{item}</p>
                          ))}
                        </div>
                      ) : null}
                      {advisor.actionConstraints.length > 0 ? (
                        <div className="advisor-list">
                          <span>签名前检查</span>
                          {advisor.actionConstraints.map((item) => (
                            <p key={item}>{item}</p>
                          ))}
                        </div>
                      ) : null}
                      <button
                        className="secondary-button full-width"
                        onClick={applyAdvisorPolicy}
                        disabled={advisor.recommendedPolicy === form.aiPolicy}
                      >
                        <Sparkles size={16} />
                        使用推荐策略
                      </button>
                    </div>
                  ) : null}
                </div>
              </section>

              <div className="alternatives">
                <h3>候选路线</h3>
                {quote.alternatives.slice(0, 5).map((alternative) => (
                  <div className="alternative-row" key={alternative.route.id}>
                    <span>{describeDisplayRoute(quote, alternative.route)}</span>
                    <strong>{formatTokenAmount(quote.tokenOut, alternative.amountOut)}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Route size={30} />
              <span>还没有报价</span>
            </div>
          )}
        </section>

        <section className="panel execution-panel">
          <div className="panel-heading">
            <Send size={18} />
            <h2>执行</h2>
          </div>

          <button className="secondary-button full-width" onClick={handleSignQuote} disabled={isBusy || !wallet || !quote}>
            <ShieldCheck size={16} />
            签名报价
          </button>
          <button className="danger-button full-width" onClick={handleSwap} disabled={isBusy || !wallet || !quote}>
            <Play size={16} />
            {quote && isNativeToken(quote.tokenIn) ? "兑换" : "授权并兑换"}
          </button>

          {signature ? (
            <div className="signature-box">
              <div>
                <span>签名</span>
                <strong>{signature.slice(0, 18)}...{signature.slice(-10)}</strong>
              </div>
              <button className="icon-button" onClick={copySignature} aria-label="复制签名">
                <Copy size={16} />
              </button>
            </div>
          ) : null}

          <div className="tx-list">
            {txHashes.map((hash) => (
              <a href={etherscanTx(hash)} target="_blank" rel="noreferrer" key={hash}>
                <span>{shortAddress(hash)}</span>
                <ExternalLink size={14} />
              </a>
            ))}
          </div>

          <div className="log-box">
            {logs.length > 0 ? logs.map((item) => <span key={item}>{item}</span>) : <span>暂无活动</span>}
          </div>
        </section>
      </section>
    </main>
  );
}

function validateForm(form: FormState): void {
  if (form.fromSymbol === form.toSymbol) {
    throw new Error("请选择两个不同的代币");
  }
  if (!Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) {
    throw new Error("数量必须大于 0");
  }
  if (!Number.isInteger(Number(form.slippageBps)) || Number(form.slippageBps) < 1) {
    throw new Error("滑点基点必须大于 0");
  }
  if (!Number.isInteger(Number(form.maxSplits)) || Number(form.maxSplits) < 1) {
    throw new Error("拆单数必须大于 0");
  }
  if (!form.rpcUrl.trim().startsWith("http")) {
    throw new Error("RPC 必须是 HTTP URL");
  }
}

function quoteMessage(quote: SmartRouteQuote, walletAddress: string): string {
  return [
    "AI 链上订单路由报价",
    `钱包：${walletAddress}`,
    `输入：${formatTokenAmount(quote.tokenIn, quote.amountIn)} ${quote.tokenIn.symbol}`,
    `输出：${formatTokenAmount(quote.tokenOut, quote.amountOut)} ${quote.tokenOut.symbol}`,
    `最低到账：${formatTokenAmount(quote.tokenOut, quote.minAmountOut)} ${quote.tokenOut.symbol}`,
    `区块：${quote.blockNumber?.toString() ?? "未知"}`,
    `生成时间：${quote.generatedAt}`,
  ].join("\n");
}

function describeDisplayRoute(
  quote: SmartRouteQuote,
  route: SmartRouteQuote["allocations"][number]["route"],
): string {
  const labels = [
    quote.tokenIn.symbol,
    ...route.hops.slice(0, -1).map((hop) => hop.tokenOut.symbol),
    quote.tokenOut.symbol,
  ];
  const dexes = route.hops.map((hop) => hop.pool.dex.name).join(" + ");
  return `${labels.join(" → ")} 通过 ${dexes}`;
}

function buildDecisionSummary(quote: SmartRouteQuote): string {
  const best = quote.alternatives[0];
  if (!best) {
    return "还没有路线评分";
  }
  const second = quote.alternatives[1];
  const routeName = describeDisplayRoute(quote, best.route);
  if (!second) {
    return `已选择 ${routeName}，因为这是唯一输出为正且可执行的路线。`;
  }
  const edge = best.netAmountOut > second.netAmountOut ? best.netAmountOut - second.netAmountOut : 0n;
  return `已选择 ${routeName}；在${quote.aiPolicy.label}下，AI 分数比下一条路线高 ${formatTokenAmount(
    quote.tokenOut,
    edge,
  )} ${quote.tokenOut.symbol}。`;
}

function analysisMetrics(quote: SmartRouteQuote): Array<{ label: string; value: string }> {
  const best = quote.alternatives[0];
  if (!best) {
    return [];
  }
  return [
    {
      label: "预期输出",
      value: `${formatTokenAmount(quote.tokenOut, best.amountOut)} ${quote.tokenOut.symbol}`,
    },
    {
      label: "风险调整后",
      value: `${formatTokenAmount(quote.tokenOut, best.netAmountOut)} ${quote.tokenOut.symbol}`,
    },
    {
      label: "AI 惩罚",
      value: `${best.aiScore.penaltyBps} 基点`,
    },
    {
      label: "跳数",
      value: String(best.risk.features.hopCount ?? best.route.hops.length),
    },
    {
      label: "储备冲击",
      value: formatBps(best.risk.features.maxTradePressureBps),
    },
    {
      label: "DEX 风险",
      value: `${best.risk.features.dexRiskBps ?? 0} 基点`,
    },
  ];
}

function buildAiAdvisorRequest(quote: SmartRouteQuote) {
  return {
    userIntent: {
      from: quote.tokenIn.symbol,
      to: quote.tokenOut.symbol,
      amount: formatTokenAmount(quote.tokenIn, quote.amountIn),
      slippageBps: quote.slippageBps,
      selectedPolicy: quote.aiPolicy.id,
    },
    executionContext: {
      chain: "Ethereum mainnet",
      tradeType: `${quote.tokenIn.symbol} 兑换 ${quote.tokenOut.symbol}`,
      selectedByDeterministicScore: quote.alternatives[0]?.route.id ?? "",
      safetyGoal: "在输出、滑点、MEV、流动性冲击和执行失败风险之间做交易前判断。",
    },
    stressTests: [
      {
        scenario: "MEV / 夹子风险",
        question: "如果交易被公开内存池观察到，哪条路线更不容易因为多跳或薄流动性被夹？",
      },
      {
        scenario: "流动性冲击",
        question: "如果最大池子的可用储备突然减少，哪条路线的输出更稳？",
      },
      {
        scenario: "gas 拥堵与失败重试",
        question: "如果 gas 突然升高或某一跳失败，是否应该选择更简单的单一路线？",
      },
      {
        scenario: "滑点不足",
        question: "当前滑点基点是否足够，是否需要调整后再签名？",
      },
      {
        scenario: "RPC 数据陈旧",
        question: "如果报价区块已经落后，用户签名前应该重新报价还是继续？",
      },
    ],
    selectedRouteId: quote.allocations[0]?.route.id ?? quote.alternatives[0]?.route.id ?? "",
    routes: quote.alternatives.slice(0, 8).map((alternative) => ({
      routeId: alternative.route.id,
      route: describeDisplayRoute(quote, alternative.route),
      expectedOut: `${formatTokenAmount(quote.tokenOut, alternative.amountOut, 8)} ${quote.tokenOut.symbol}`,
      aiScore: `${formatTokenAmount(quote.tokenOut, alternative.netAmountOut, 8)} ${quote.tokenOut.symbol}`,
      aiPenaltyBps: alternative.aiScore.penaltyBps,
      rawRiskPenaltyBps: alternative.risk.penaltyBps,
      hopCount: alternative.risk.features.hopCount ?? alternative.route.hops.length,
      reserveImpactBps: alternative.risk.features.maxTradePressureBps ?? 0,
      dexRiskBps: alternative.risk.features.dexRiskBps ?? 0,
      reasons: alternative.aiScore.reasons,
    })),
  };
}

function routeNameForId(quote: SmartRouteQuote, routeId: string): string {
  const alternative = quote.alternatives.find((item) => item.route.id === routeId);
  return alternative ? describeDisplayRoute(quote, alternative.route) : routeId;
}

function formatBps(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0.00%";
  }
  return `${(value / 100).toFixed(2)}%`;
}

function formatAdvisorVerdict(verdict: AiAdvisorResponse["routeNotes"][number]["verdict"]): string {
  if (verdict === "prefer") {
    return "优先";
  }
  if (verdict === "acceptable") {
    return "可接受";
  }
  return "避开";
}

function formatExecutionDecision(decision: AiAdvisorResponse["executionGate"]["decision"]): string {
  if (decision === "execute") {
    return "可以执行";
  }
  if (decision === "adjust") {
    return "先调整";
  }
  return "暂缓交易";
}

function formatSeverity(severity: AiAdvisorResponse["scenarios"][number]["severity"]): string {
  if (severity === "high") {
    return "高风险";
  }
  if (severity === "medium") {
    return "中风险";
  }
  return "低风险";
}

function isPositiveStatus(status: string): boolean {
  return /就绪|已连接|已生成|已签名|已确认|已应用/.test(status);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
