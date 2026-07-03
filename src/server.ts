import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createViteServer } from "vite";
import OpenAI from "openai";
import type { AiAdvisorRequest } from "./aiAdvisor.js";
import { isAiAdvisorResponse, isPolicy } from "./aiAdvisor.js";

const host = "127.0.0.1";
const port = Number(process.env.AI_ADVISOR_PORT ?? 5173);

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
      res.end("Not found");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`AI router app running at http://${host}:${port}`);
});

async function handleAiAdvice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-your-key")) {
    writeJson(res, 501, {
      error: "AI Advisor is not configured.",
      setupHint: "Set OPENAI_API_KEY in .env and restart npm run dev.",
    });
    return;
  }

  const request = JSON.parse(await readBody(req)) as AiAdvisorRequest;
  validateAdvisorRequest(request);

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.5",
    instructions: [
      "You are an on-chain DEX smart order routing advisor.",
      "You only evaluate candidate routes supplied by the app.",
      "You never ask for private keys, seed phrases, signatures, or wallet permissions.",
      "You cannot create new calldata or new routes.",
      "Return strict JSON only. No markdown.",
    ].join("\n"),
    input: JSON.stringify({
      task: "Choose a routing policy and route from the candidates. Explain tradeoffs.",
      schema: {
        recommendedPolicy: "max-output | balanced | conservative",
        recommendedRouteId: "one of the supplied routeId values",
        confidence: "number from 0 to 1",
        thesis: "short explanation",
        routeNotes: [
          {
            routeId: "candidate routeId",
            verdict: "prefer | acceptable | avoid",
            reason: "one sentence",
          },
        ],
        warnings: ["execution, slippage, MEV, or liquidity warnings"],
        actionConstraints: ["things user must verify before signing"],
      },
      request,
    }),
    store: false,
  });

  const parsed = parseAdvisorJson(response.output_text);
  if (!isAiAdvisorResponse(parsed)) {
    throw new Error("AI Advisor returned an invalid response shape");
  }

  const routeIds = new Set(request.routes.map((route) => route.routeId));
  if (!routeIds.has(parsed.recommendedRouteId)) {
    throw new Error("AI Advisor recommended a route outside the candidate set");
  }
  if (!isPolicy(parsed.recommendedPolicy)) {
    throw new Error("AI Advisor recommended an invalid policy");
  }

  writeJson(res, 200, parsed);
}

function validateAdvisorRequest(request: AiAdvisorRequest): void {
  if (!request.routes?.length) {
    throw new Error("AI Advisor needs at least one route");
  }
  if (!request.routes.some((route) => route.routeId === request.selectedRouteId)) {
    throw new Error("Selected route is missing from candidate routes");
  }
}

function parseAdvisorJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("AI Advisor did not return JSON");
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const size = chunks.reduce((sum, item) => sum + item.length, 0);
    if (size > 128_000) {
      throw new Error("Request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
