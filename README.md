# AI 链上智能订单路由

一个可跑的 Web3 智能订单路由原型。它不会默认签名或广播真实交易，而是做三件事：

1. 从 demo 池子或链上 Uniswap V2 类 DEX 读取流动性。
2. 搜索直连和多跳路径，支持拆单。
3. 用透明的 AI-style scoring policy 输出最优路由、风险解释、最小可接受输出和可选 calldata。

## 快速开始

```powershell
cd C:\Users\zexi\ai-onchain-router
npm install
npm run demo
```

## 本地 UI

```powershell
cd C:\Users\zexi\ai-onchain-router
npm run dev
```

如果要启用 Cloudflare Workers AI 二次分析：

1. 打开 Cloudflare Dashboard，进入 Workers AI 页面。
2. 选择 `Use REST API`。
3. 点击 `Create a Workers AI API Token`，创建后复制 API token。
4. 复制页面里的 Account ID。
5. 复制 `.env.example` 为 `.env`。
6. 在 `.env` 里填入 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。
7. 重启 `npm run dev`。

`.env` 示例：

```env
CLOUDFLARE_ACCOUNT_ID=你的-cloudflare-account-id
CLOUDFLARE_API_TOKEN=你的-workers-ai-token
CLOUDFLARE_AI_MODEL=@cf/meta/llama-3.1-8b-instruct-fast
```

如果本机需要代理访问 Cloudflare，可以在 `.env` 里加 `HTTPS_PROXY=http://127.0.0.1:7897`，后端会自动使用它。

不配置 key 时，页面仍可正常 quote 和 swap，但 `Ask AI Advisor` 会显示配置提示。Cloudflare Workers AI 免费额度是每天 10,000 Neurons，超过免费额度需要升级 Workers Paid plan。

打开 Vite 给出的本地地址。页面支持：

- 连接浏览器注入钱包，例如 MetaMask 或 Rabby。
- 读取 Ethereum mainnet 上 Uniswap V2 / SushiSwap V2 类池子的 reserves。
- 生成只包含单一 router 可执行路径的智能路由。
- 支持 native ETH 输入，例如 `ETH -> USDC`，执行时调用 `swapExactETHForTokens` 并跳过 ERC20 approval。
- 展示 `AI Analysis`：评分公式、候选路线排名、risk-adjusted score、流动性冲击和 route 选择理由。
- `AI Strategy` 会参与真实路由决策：`Max Output` 追求最大输出，`Balanced` 平衡输出和风险，`Conservative` 更重地惩罚高风险路径。
- `Ask AI Advisor` 会把候选 route 发给本地 server，由 Cloudflare Workers AI 做二次推理，返回推荐策略、推荐 route、信心和风险提示。
- 签名当前 quote。
- 依次发起 ERC20 approval 和 swap 交易，由钱包逐笔确认。

## 链上报价

先复制 `.env.example` 为 `.env`，填入主网 RPC：

```powershell
cd C:\Users\zexi\ai-onchain-router
Copy-Item .env.example .env
npm run live -- --from USDC --to WETH --amount 1000 --max-hops 2 --splits 6
```

生成交易 calldata：

```powershell
npm run live -- --from USDC --to WETH --amount 1000 --to-address 0xYourWallet --slippage-bps 50
```

程序只会输出交易目标地址和 calldata，不会帮你签名或广播。

## 设计边界

- 当前支持 EVM 链和 Uniswap V2/QuickSwap/SushiSwap 这类 constant-product 池。
- AI 部分是可解释评分器，不是黑盒模型：输出量、滑点、池子冲击、hop 数、DEX 风险共同决定最终排序。
- UI 的真实 swap 模式只选择同一个 router 内可执行的路径。跨 DEX 混合多跳需要聚合器执行合约，当前不会伪装成可交易路径。
- 生产使用前还需要加：MEV 保护、permit/approval 管理、私有交易通道、价格预言机、失败回滚策略、合约级审计和链上模拟。
