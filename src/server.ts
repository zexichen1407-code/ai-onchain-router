import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { createServer as createViteServer } from "vite";
import type { AiAdvisorRequest, AiAdvisorResponse } from "./aiAdvisor.js";
import { isAiAdvisorResponse, isPolicy } from "./aiAdvisor.js";

const host = "127.0.0.1";
const port = Number(process.env.AI_ADVISOR_PORT ?? 5173);
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const vite = await createViteServer({
  appType: "spa",
  server: { middlewareMode: true },
});

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/ai-advice") {
      await handleAiAdvice(req, res);
      return;
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("未找到");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`AI 链上订单路由已启动：http://${host}:${port}`);
});

async function handleAiAdvice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !apiToken ||
    !accountId ||
    apiToken === "your-cloudflare-workers-ai-token" ||
    accountId === "your-cloudflare-account-id"
  ) {
    writeJson(res, 501, {
      error: "AI 顾问还没有配置。",
      setupHint: "请在 .env 里设置 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN，然后重启 npm run dev。",
    });
    return;
  }

  const request = JSON.parse(await readBody(req)) as AiAdvisorRequest;
  validateAdvisorRequest(request);

  const parsed = await askCloudflareAdvisor(accountId, apiToken, request);
  if (!isAiAdvisorResponse(parsed)) {
    throw new Error("AI 顾问返回格式无效");
  }

  const routeIds = new Set(request.routes.map((route) => route.routeId));
  const normalized = normalizeAdvisorResponse(parsed, routeIds, request.selectedRouteId);
  if (!routeIds.has(normalized.recommendedRouteId)) {
    throw new Error("AI 顾问推荐了候选集之外的路线");
  }
  for (const scenario of normalized.scenarios) {
    if (!routeIds.has(scenario.preferredRouteId)) {
      throw new Error("AI 顾问的场景分析引用了候选集之外的路线");
    }
  }
  if (normalized.scenarios.length < 4) {
    throw new Error("AI 顾问没有完成足够的复杂场景压力测试");
  }
  if (!isPolicy(normalized.recommendedPolicy)) {
    throw new Error("AI 顾问推荐了无效策略");
  }
  const recommendedNote = normalized.routeNotes.find((note) => note.routeId === normalized.recommendedRouteId);
  if (recommendedNote?.verdict !== "prefer") {
    throw new Error("AI 顾问的路线说明和最终推荐路线不一致");
  }

  writeJson(res, 200, normalized);
}

async function askCloudflareAdvisor(
  accountId: string,
  apiToken: string,
  request: AiAdvisorRequest,
): Promise<unknown> {
  const model = process.env.CLOUDFLARE_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const prompt = JSON.stringify({
    task: "不要只复述最高分。从候选路线中做链上兑换前的复杂场景压力测试，再选择策略和路线。",
    rules: [
      "只能评估应用提供的候选路线。",
      "不要索要私钥、助记词、签名或钱包权限。",
      "不要创建新的 calldata 或新的路线。",
      "只返回严格 JSON，不要返回 markdown。",
      "必须模拟至少 4 个复杂场景：MEV/夹子风险、流动性冲击、gas 拥堵或失败重试、滑点不足、RPC 数据陈旧。",
      "scenarios 必须一项对应一个压力测试场景，不能把多个场景合并成一项。",
      "如果最高原始输出路线在复杂场景里更脆弱，可以推荐低分但更稳的路线。",
      "executionGate.mustCheck 和 actionConstraints 必须拆成 3 到 5 条短句，不要把所有检查项合成一条。",
      "routeNotes 里的 recommendedRouteId 必须标记为 prefer，不要把非最终推荐路线标记为 prefer。",
      "thesis、aiContribution、executionGate.reason、executionGate.mustCheck、scenarios、routeNotes.reason、warnings、actionConstraints 必须使用简体中文。",
    ],
    schema: {
      recommendedPolicy: "max-output | balanced | conservative",
      recommendedRouteId: "必须是输入里的某个 routeId",
      confidence: "0 到 1 之间的数字",
      thesis: "中文短解释",
      aiContribution: "一句话说明 AI 相比固定算法额外判断了什么复杂条件",
      executionGate: {
        decision: "execute | adjust | avoid",
        reason: "中文说明为什么可以执行、需要调整或应该暂缓",
        suggestedSlippageBps: "建议滑点基点，必须是数字",
        mustCheck: ["签名前必须检查的中文事项"],
      },
      scenarios: [
        {
          scenario: "中文场景名称，例如 MEV 夹子风险",
          severity: "low | medium | high",
          preferredRouteId: "该场景下更适合的候选 routeId",
          impact: "中文说明该场景对路线的影响",
          action: "中文说明用户应该怎么处理",
        },
      ],
      routeNotes: [
        {
          routeId: "候选 routeId",
          verdict: "prefer | acceptable | avoid",
          reason: "一句中文理由",
        },
      ],
      warnings: ["中文风险提示，例如执行、滑点、MEV 或流动性风险"],
      actionConstraints: ["用户签名前必须确认的中文检查项"],
    },
    request,
  });

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "你是链上 DEX 智能订单路由顾问。只返回有效 JSON，不要输出 markdown。所有面向用户的解释必须使用简体中文。",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 2200,
        response_format: {
          type: "json_schema",
          json_schema: advisorResponseSchema,
        },
      }),
    },
  );

  const payload = (await response.json()) as CloudflareChatCompletionResponse | CloudflareErrorResponse;
  if (!response.ok) {
    throw new Error(cloudflareErrorMessage(payload));
  }
  const text = "choices" in payload ? payload.choices?.[0]?.message?.content : undefined;
  if (!text) {
    throw new Error("Cloudflare AI 没有返回文本");
  }
  return parseAdvisorJson(text);
}

function validateAdvisorRequest(request: AiAdvisorRequest): void {
  if (!request.routes?.length) {
    throw new Error("AI 顾问至少需要一条候选路线");
  }
  if (!request.routes.some((route) => route.routeId === request.selectedRouteId)) {
    throw new Error("已选路线不在候选路线里");
  }
}

function normalizeAdvisorResponse(
  response: AiAdvisorResponse,
  routeIds: Set<string>,
  fallbackRouteId: string,
): AiAdvisorResponse {
  const recommendedRouteId = routeIds.has(response.recommendedRouteId)
    ? response.recommendedRouteId
    : fallbackRouteId;
  const normalizedScenarios = response.scenarios.map((scenario) => ({
    ...scenario,
    preferredRouteId: routeIds.has(scenario.preferredRouteId) ? scenario.preferredRouteId : recommendedRouteId,
  }));
  const routeNotes: AiAdvisorResponse["routeNotes"] = response.routeNotes.map((note) => {
    const verdict: AiAdvisorResponse["routeNotes"][number]["verdict"] =
      note.routeId === recommendedRouteId ? "prefer" : note.verdict === "prefer" ? "acceptable" : note.verdict;
    return {
      ...note,
      verdict,
    };
  });
  if (!routeNotes.some((note) => note.routeId === recommendedRouteId)) {
    routeNotes.unshift({
      routeId: recommendedRouteId,
      verdict: "prefer",
      reason: "AI 最终推荐这条路线，因为它在复杂场景压力测试后的综合风险更可控。",
    });
  }

  return {
    ...response,
    recommendedRouteId,
    scenarios: normalizedScenarios,
    routeNotes,
  };
}

function parseAdvisorJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("AI 顾问没有返回 JSON");
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

const advisorResponseSchema = {
  type: "object",
  properties: {
    recommendedPolicy: { type: "string", enum: ["max-output", "balanced", "conservative"] },
    recommendedRouteId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    thesis: { type: "string" },
    aiContribution: { type: "string" },
    executionGate: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["execute", "adjust", "avoid"] },
        reason: { type: "string" },
        suggestedSlippageBps: { type: "number" },
        mustCheck: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } },
      },
      required: ["decision", "reason", "suggestedSlippageBps", "mustCheck"],
    },
    scenarios: {
      type: "array",
      minItems: 4,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          scenario: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          preferredRouteId: { type: "string" },
          impact: { type: "string" },
          action: { type: "string" },
        },
        required: ["scenario", "severity", "preferredRouteId", "impact", "action"],
      },
    },
    routeNotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          routeId: { type: "string" },
          verdict: { type: "string", enum: ["prefer", "acceptable", "avoid"] },
          reason: { type: "string" },
        },
        required: ["routeId", "verdict", "reason"],
      },
    },
    warnings: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    actionConstraints: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } },
  },
  required: [
    "recommendedPolicy",
    "recommendedRouteId",
    "confidence",
    "thesis",
    "aiContribution",
    "executionGate",
    "scenarios",
    "routeNotes",
    "warnings",
    "actionConstraints",
  ],
};

interface CloudflareChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface CloudflareErrorResponse {
  error?: {
    message?: string;
  };
  errors?: Array<{
    message?: string;
  }>;
}

function cloudflareErrorMessage(payload: CloudflareChatCompletionResponse | CloudflareErrorResponse): string {
  if ("error" in payload && payload.error?.message) {
    return `Cloudflare AI 调用失败：${payload.error.message}`;
  }
  if ("errors" in payload && payload.errors?.[0]?.message) {
    return `Cloudflare AI 调用失败：${payload.errors[0].message}`;
  }
  return "Cloudflare AI 调用失败";
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const size = chunks.reduce((sum, item) => sum + item.length, 0);
    if (size > 128_000) {
      throw new Error("请求体过大");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
