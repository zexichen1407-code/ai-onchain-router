# AI 链上智能订单路由

一个可跑的 Web3 智能订单路由原型。它不会默认签名或广播真实交易，而是做三件事：

1. 从 demo 池子或链上 Uniswap V2 类 DEX 读取流动性。
2. 搜索直连和多跳路径，支持拆单。
3. 用透明评分算法先生成候选路线，再用 Cloudflare Workers AI 做复杂场景压力测试。

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

不配置 key 时，页面仍可正常获取报价和发起兑换，但 `询问 AI 顾问` 会显示配置提示。Cloudflare Workers AI 免费额度是每天 10,000 Neurons，超过免费额度需要升级 Workers Paid plan。

打开 Vite 给出的本地地址。页面支持：

- 连接浏览器注入钱包，例如 MetaMask 或 Rabby。
- 读取 Ethereum mainnet 上 Uniswap V2 / SushiSwap V2 类池子的 reserves。
- 生成只包含单一 router 可执行路径的智能路由。
- 支持 native ETH 输入，例如 `ETH -> USDC`，执行时调用 `swapExactETHForTokens` 并跳过 ERC20 approval。
- 展示 `AI 分析`：评分公式、候选路线排名、风险调整后输出、流动性冲击和路线选择理由。
- `AI 策略` 会参与真实路由决策：`最大输出` 追求最大输出，`平衡策略` 平衡输出和风险，`保守策略` 更重地惩罚高风险路径。
- `询问 AI 顾问` 会把候选 route 发给本地 server，由 Cloudflare Workers AI 做复杂场景压力测试，返回执行闸门、推荐策略、推荐 route、信心和风险提示。
- 签名当前 quote。
- 依次发起 ERC20 approval 和 swap 交易，由钱包逐笔确认。

## 算法评分逻辑

算法层是确定性的，负责把链上池子转成可排序的候选路线。这里的 `AI score` 是代码里的风险调整分数字段，不是大模型推理；真正的大模型分析在下一节。

1. 代币标准化
   - 如果用户输入 `ETH`，路由计算会先把它映射成 `WETH` 池子。
   - UI 执行真实交易时仍保留 native ETH 语义，调用 `swapExactETHForTokens`。

2. 候选路线搜索
   - 从 Uniswap V2 / SushiSwap V2 这类 constant-product 池子读取 reserves。
   - 用 DFS 搜索直连和多跳路线，当前 UI 默认最多 2 跳。
   - UI 真实交易只选择同一个 router 内可执行的路线，避免展示跨 router 但当前合约不能执行的路径。

3. AMM 报价公式
   - 每一跳使用 Uniswap V2 exact-in 公式：
   - `amountInWithFee = amountIn * (10000 - feeBps)`
   - `amountOut = amountInWithFee * reserveOut / (reserveIn * 10000 + amountInWithFee)`
   - 多跳路线会把上一跳输出作为下一跳输入。

4. 风险惩罚
   - `hopPenaltyBps = (hopCount - 1) * 18`
   - `dexRiskBps = 各跳 DEX riskBps 的平均值`
   - `maxTradePressureBps = max(单跳输入金额 * 10000 / 该跳 reserveIn)`
   - `liquidityPenaltyBps = min(700, maxTradePressureBps * 0.22)`
   - `rawRiskPenaltyBps = min(2500, hopPenaltyBps + dexRiskBps + liquidityPenaltyBps)`

5. 策略评分权重
   - `最大输出`：`riskMultiplierBps = 0`，基本只看预期输出。
   - `平衡策略`：`riskMultiplierBps = 10000`，完整计入风险惩罚。
   - `保守策略`：`riskMultiplierBps = 22000`，放大风险惩罚。
   - 代码里把风险调整后的字段命名为 `AI penalty` / `AI score`，它们属于可解释算法分数。
   - `AI penalty = clamp(rawRiskPenaltyBps * riskMultiplierBps / 10000, 0, 9000)`
   - `AI score = expectedOutput * (10000 - AI penalty) / 10000`

6. 拆单分配
   - 程序把输入金额切成多个 chunk。
   - 每个 chunk 都按当前池子状态模拟执行。
   - 每轮把 chunk 分配给风险调整后输出最高的路线，并更新该路线的模拟 reserves。
   - 最终输出 `allocations`、`amountOut`、`minAmountOut` 和候选路线排名。

## AI 分析逻辑

AI 不负责生成 calldata，也不能创建新路线。它只在算法已经给出的候选 route 上做交易前复杂判断。

1. 前端发送给本地 server 的内容
   - 用户意图：卖出/买入代币、数量、滑点、当前 AI 策略。
   - 执行上下文：Ethereum mainnet、交易类型、算法当前选择、安全目标。
   - 候选路线：每条 route 的预期输出、AI score、AI penalty、原始风险惩罚、跳数、储备冲击、DEX 风险和算法理由。
   - 压力测试问题：MEV/夹子风险、流动性冲击、gas 拥堵或失败重试、滑点不足、RPC 数据陈旧。

2. Cloudflare Workers AI 的任务
   - 不允许索要私钥、助记词、签名或钱包权限。
   - 不允许创建新的 calldata 或新 route。
   - 必须只从候选 route 中选择。
   - 必须输出至少 4 个复杂场景压力测试。
   - 如果最高原始输出路线在复杂场景里更脆弱，AI 可以推荐低分但更稳的路线。

3. AI 返回内容
   - `AI 额外贡献`：说明 AI 相比固定算法额外判断了什么复杂条件。
   - `AI 执行闸门`：`可以执行`、`先调整` 或 `暂缓交易`。
   - `建议滑点`：AI 建议的 slippage bps。
   - `复杂场景压力测试`：每个场景的风险级别、影响、动作和偏好路线。
   - `推荐策略 / 推荐路线 / 信心`：供用户手动应用。
   - `签名前检查`：用户在钱包弹窗前必须确认的事项。

4. 本地安全校验
   - AI 返回必须符合 JSON schema。
   - `recommendedRouteId` 必须来自候选 route。
   - 场景分析至少 4 条。
   - 如果 AI 在场景里引用不存在的 routeId，本地会归一化回合法候选 route。
   - 最终推荐 route 必须在 route notes 里标记为 `prefer`，避免推荐和解释互相矛盾。

## 钱包连接与交易逻辑

钱包逻辑只通过浏览器注入的 `window.ethereum` 工作，例如 MetaMask 或 Rabby。

1. 连接钱包
   - 读取 `window.ethereum`。
   - 调用 `eth_requestAccounts` 请求用户授权连接账户。
   - 调用 `eth_chainId` 读取当前链。
   - 如果不是 Ethereum mainnet，页面会提示切换。

2. 切换主网
   - 优先调用 `wallet_switchEthereumChain` 切换到 `0x1`。
   - 如果钱包没有这条链，会调用 `wallet_addEthereumChain` 添加 Ethereum Mainnet。

3. 报价阶段
   - 报价只用 RPC 读取池子 reserves。
   - 报价不会触发钱包签名。
   - 报价不会发送交易。

4. 签名报价
   - 点击 `签名报价` 时调用钱包的 `signMessage`。
   - 签名内容是当前 quote 的摘要：钱包地址、输入、输出、最低到账、区块和生成时间。
   - 这是消息签名，不是链上交易。

5. 授权与兑换
   - 如果输入是 native ETH，程序跳过 ERC20 approval。
   - 如果输入是 ERC20，程序先读取 `allowance`。
   - 如果已有 allowance 足够，不重复授权。
   - 如果已有非零 allowance 但不足，先把 allowance 重置为 0，再授权本次需要的数量。
   - 最后通过钱包发送 swap 交易，用户必须在钱包里逐笔确认。

6. 安全边界
   - 本项目不会读取私钥或助记词。
   - 本项目不会自动签名。
   - 本项目不会绕过钱包弹窗。
   - Cloudflare AI 只看候选路线数据，不接触私钥、助记词或钱包权限。
   - 真正的风险来自用户在钱包里确认的 approval 和 swap；签名前必须检查 router 地址、授权数量、最低到账和链 ID。

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
- 算法评分层是可解释的：输出量、滑点、池子冲击、hop 数、DEX 风险共同决定初始排序。
- AI 顾问层用于复杂场景压力测试，不直接生成交易，也不会绕过用户确认。
- UI 的真实 swap 模式只选择同一个 router 内可执行的路径。跨 DEX 混合多跳需要聚合器执行合约，当前不会伪装成可交易路径。
- 生产使用前还需要加：MEV 保护、permit/approval 管理、私有交易通道、价格预言机、失败回滚策略、合约级审计和链上模拟。
