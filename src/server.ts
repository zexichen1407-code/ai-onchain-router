import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { createServer as createViteServer } from "vite";
import type { AiAdvisorRequest } from "./aiAdvisor.js";
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
  if (!routeIds.has(parsed.recommendedRouteId)) {
    throw new Error("AI 顾问推荐了候选集之外的路线");
  }
  if (!isPolicy(parsed.recommendedPolicy)) {
    throw new Error("AI 顾问推荐了无效策略");
  }

  writeJson(res, 200, parsed);
}

async function askCloudflareAdvisor(
  accountId: string,
  apiToken: string,
  request: AiAdvisorRequest,
): Promise<unknown> {
  const model = process.env.CLOUDFLARE_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const prompt = JSON.stringify({
    task: "从候选路线里选择一个路由策略和一条路线，并用中文解释权衡。",
    rules: [
      "只能评估应用提供的候选路线。",
      "不要索要私钥、助记词、签名或钱包权限。",
      "不要创建新的 calldata 或新的路线。",
      "只返回严格 JSON，不要返回 markdown。",
      "thesis、routeNotes.reason、warnings、actionConstraints 必须使用简体中文。",
    ],
    schema: {
      recommendedPolicy: "max-output | balanced | conservative",
      recommendedRouteId: "必须是输入里的某个 routeId",
      confidence: "0 到 1 之间的数字",
      thesis: "中文短解释",
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
        max_tokens: 1200,
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
    warnings: { type: "array", items: { type: "string" } },
    actionConstraints: { type: "array", items: { type: "string" } },
  },
  required: [
    "recommendedPolicy",
    "recommendedRouteId",
    "confidence",
    "thesis",
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
