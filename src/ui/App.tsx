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
  const [status, setStatus] = useState("Ready");
  const [signature, setSignature] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<Hash[]>([]);
  const [logs, setLogs] = useState<string[]>([]);

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
      setStatus(connected.chainId === 1 ? "Wallet connected" : "Wrong network");
      log(`Connected ${shortAddress(connected.address)}`);
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
      setStatus("Mainnet active");
      log("Switched to Ethereum mainnet");
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
      setStatus("Loading pools");
      setQuote(null);
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
      setStatus("Quote ready");
      log(`Quoted ${nextQuote.allocations.length} allocation(s) from ${pools.length} pools`);
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSignQuote() {
    if (!wallet || !quote) {
      setStatus("Wallet and quote required");
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
      setStatus("Quote signed");
      log("Quote signature captured");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSwap() {
    if (!wallet || !quote) {
      setStatus("Wallet and quote required");
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
          log("Native ETH input; approval skipped");
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
        log(`Swap confirmed ${shortAddress(swapHash)}`);
      }

      setStatus("Swap confirmed");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy("idle");
    }
  }

  async function copySignature() {
    if (!signature) {
      return;
    }
    await navigator.clipboard.writeText(signature);
    log("Signature copied");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Ethereum Mainnet</p>
          <h1>AI On-chain Router</h1>
        </div>
        <div className="wallet-stack">
          {wallet ? (
            <div className="wallet-chip">
              <Wallet size={16} />
              <span>{shortAddress(wallet.address)}</span>
              <span className={wallet.chainId === 1 ? "chain-ok" : "chain-bad"}>
                {wallet.chainId === 1 ? "Mainnet" : `Chain ${wallet.chainId}`}
              </span>
            </div>
          ) : null}
          {wallet && wallet.chainId !== 1 ? (
            <button className="secondary-button" onClick={handleSwitchNetwork} disabled={isBusy}>
              <RefreshCw size={16} />
              Switch
            </button>
          ) : (
            <button className="primary-button" onClick={handleConnect} disabled={isBusy}>
              <Wallet size={16} />
              {wallet ? "Reconnect" : "Connect"}
            </button>
          )}
        </div>
      </header>

      <section className="status-row">
        <div className="status-pill">
          {status === "Ready" || status.includes("ready") || status.includes("connected") ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <span>{status}</span>
        </div>
        <span>{poolCount > 0 ? `${poolCount} pools loaded` : "No pools loaded"}</span>
      </section>

      <section className="workspace-grid">
        <form className="panel order-panel" onSubmit={(event) => event.preventDefault()}>
          <div className="panel-heading">
            <Route size={18} />
            <h2>Order</h2>
          </div>

          <label>
            <span>From</span>
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
            <span>To</span>
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
            <span>Amount</span>
            <input
              value={form.amount}
              inputMode="decimal"
              onChange={(event) => patchForm({ amount: event.target.value })}
            />
          </label>

          <div className="field-row">
            <label>
              <span>Slippage bps</span>
              <input
                value={form.slippageBps}
                inputMode="numeric"
                onChange={(event) => patchForm({ slippageBps: event.target.value })}
              />
            </label>
            <label>
              <span>Splits</span>
              <input
                value={form.maxSplits}
                inputMode="numeric"
                onChange={(event) => patchForm({ maxSplits: event.target.value })}
              />
            </label>
          </div>

          <label>
            <span>Max hops</span>
            <select value={form.maxHops} onChange={(event) => patchForm({ maxHops: event.target.value })}>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </label>

          <label>
            <span>AI Strategy</span>
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
            Quote
          </button>
        </form>

        <section className="panel route-panel">
          <div className="panel-heading">
            <ShieldCheck size={18} />
            <h2>Route</h2>
          </div>

          {quote ? (
            <>
              <div className="quote-summary">
                <div>
                  <span>Input</span>
                  <strong>
                    {formatTokenAmount(quote.tokenIn, quote.amountIn)} {quote.tokenIn.symbol}
                  </strong>
                </div>
                <div>
                  <span>Output</span>
                  <strong>
                    {formatTokenAmount(quote.tokenOut, quote.amountOut)} {quote.tokenOut.symbol}
                  </strong>
                </div>
                <div>
                  <span>Min</span>
                  <strong>
                    {formatTokenAmount(quote.tokenOut, quote.minAmountOut)} {quote.tokenOut.symbol}
                  </strong>
                </div>
                <div>
                  <span>Block</span>
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
                    <span>AI Analysis</span>
                    <h3>{buildDecisionSummary(quote)}</h3>
                  </div>
                  <Sparkles size={18} />
                </div>

                <p className="analysis-formula">
                  {quote.aiPolicy.label}: AI score = expected output x (10000 - AI penalty bps) / 10000
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
                          <span>{index === 0 ? "Selected" : "Candidate"}</span>
                        </div>
                        <div className="rank-grid">
                          <span>
                            expected {formatTokenAmount(quote.tokenOut, alternative.amountOut)}{" "}
                            {quote.tokenOut.symbol}
                          </span>
                          <span>
                            AI score {formatTokenAmount(quote.tokenOut, alternative.netAmountOut)}{" "}
                            {quote.tokenOut.symbol}
                          </span>
                          <span>AI penalty {alternative.aiScore.penaltyBps} bps</span>
                          <span>impact {formatBps(alternative.risk.features.maxTradePressureBps)}</span>
                        </div>
                        <p>{alternative.aiScore.reasons.join("; ")}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <div className="alternatives">
                <h3>Alternatives</h3>
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
              <span>No quote</span>
            </div>
          )}
        </section>

        <section className="panel execution-panel">
          <div className="panel-heading">
            <Send size={18} />
            <h2>Execution</h2>
          </div>

          <button className="secondary-button full-width" onClick={handleSignQuote} disabled={isBusy || !wallet || !quote}>
            <ShieldCheck size={16} />
            Sign Quote
          </button>
          <button className="danger-button full-width" onClick={handleSwap} disabled={isBusy || !wallet || !quote}>
            <Play size={16} />
            {quote && isNativeToken(quote.tokenIn) ? "Swap" : "Approve & Swap"}
          </button>

          {signature ? (
            <div className="signature-box">
              <div>
                <span>Signature</span>
                <strong>{signature.slice(0, 18)}...{signature.slice(-10)}</strong>
              </div>
              <button className="icon-button" onClick={copySignature} aria-label="Copy signature">
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
            {logs.length > 0 ? logs.map((item) => <span key={item}>{item}</span>) : <span>No activity</span>}
          </div>
        </section>
      </section>
    </main>
  );
}

function validateForm(form: FormState): void {
  if (form.fromSymbol === form.toSymbol) {
    throw new Error("Choose two different tokens");
  }
  if (!Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) {
    throw new Error("Amount must be positive");
  }
  if (!Number.isInteger(Number(form.slippageBps)) || Number(form.slippageBps) < 1) {
    throw new Error("Slippage bps must be positive");
  }
  if (!Number.isInteger(Number(form.maxSplits)) || Number(form.maxSplits) < 1) {
    throw new Error("Splits must be positive");
  }
  if (!form.rpcUrl.trim().startsWith("http")) {
    throw new Error("RPC must be an HTTP URL");
  }
}

function quoteMessage(quote: SmartRouteQuote, walletAddress: string): string {
  return [
    "AI On-chain Router Quote",
    `Wallet: ${walletAddress}`,
    `Input: ${formatTokenAmount(quote.tokenIn, quote.amountIn)} ${quote.tokenIn.symbol}`,
    `Output: ${formatTokenAmount(quote.tokenOut, quote.amountOut)} ${quote.tokenOut.symbol}`,
    `Min Output: ${formatTokenAmount(quote.tokenOut, quote.minAmountOut)} ${quote.tokenOut.symbol}`,
    `Block: ${quote.blockNumber?.toString() ?? "unknown"}`,
    `Generated: ${quote.generatedAt}`,
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
  return `${labels.join(" -> ")} via ${dexes}`;
}

function buildDecisionSummary(quote: SmartRouteQuote): string {
  const best = quote.alternatives[0];
  if (!best) {
    return "No route scored yet";
  }
  const second = quote.alternatives[1];
  const routeName = describeDisplayRoute(quote, best.route);
  if (!second) {
    return `Selected ${routeName} because it is the only executable route with positive output.`;
  }
  const edge = best.netAmountOut > second.netAmountOut ? best.netAmountOut - second.netAmountOut : 0n;
  return `Selected ${routeName}; ${quote.aiPolicy.label} AI score leads the next route by ${formatTokenAmount(
    quote.tokenOut,
    edge,
  )} ${quote.tokenOut.symbol}.`;
}

function analysisMetrics(quote: SmartRouteQuote): Array<{ label: string; value: string }> {
  const best = quote.alternatives[0];
  if (!best) {
    return [];
  }
  return [
    {
      label: "Expected",
      value: `${formatTokenAmount(quote.tokenOut, best.amountOut)} ${quote.tokenOut.symbol}`,
    },
    {
      label: "Risk-adjusted",
      value: `${formatTokenAmount(quote.tokenOut, best.netAmountOut)} ${quote.tokenOut.symbol}`,
    },
    {
      label: "AI penalty",
      value: `${best.aiScore.penaltyBps} bps`,
    },
    {
      label: "Hops",
      value: String(best.risk.features.hopCount ?? best.route.hops.length),
    },
    {
      label: "Reserve impact",
      value: formatBps(best.risk.features.maxTradePressureBps),
    },
    {
      label: "DEX risk",
      value: `${best.risk.features.dexRiskBps ?? 0} bps`,
    },
  ];
}

function formatBps(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0.00%";
  }
  return `${(value / 100).toFixed(2)}%`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
