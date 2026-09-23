/**
 * LLM 引擎状态路由
 * GET  /api/llm/status  — 探测 LLM（Ollama 等 OpenAI 兼容端点）连通性
 * POST /api/llm/wake    — 一键启动（引擎状态机接管，进展走 SSE）
 * POST /api/llm/sleep   — 一键关闭（同上）
 * GET  /api/llm/stream  — SSE 事件流：状态变化即时推送（替代前端轮询）+ 心跳保活
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { API_TAGS } from "../lib/api-convention";
import {
  getLlmEngineSnapshot,
  sleepEngine,
  subscribeLlmEvents,
  wakeEngine,
} from "../services/llm-engine";
import { probeLlm } from "../services/llm.service";

const statusSchema = z.object({
  connected: z.boolean(),
  model: z.string(),
  installed: z.boolean().optional(),
  loaded: z.boolean().optional(),
  reason: z.string().optional(),
});

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: [API_TAGS.llm],
  operationId: "getLlmStatus",
  summary: "LLM 引擎就绪状态（服务可达/模型已安装/模型已加载三级探测）",
  responses: {
    200: {
      description: "LLM 连接状态",
      content: { "application/json": { schema: statusSchema } },
    },
  },
});

const wakeRoute = createRoute({
  method: "post",
  path: "/wake",
  tags: [API_TAGS.llm],
  operationId: "wakeLlm",
  summary:
    "一键启动 Ollama 并把配置模型加载进内存（仅本机开发环境；加载异步，前端轮询 status 感知就绪）",
  responses: {
    200: {
      description: "唤醒后的最新状态（模型加载可能仍在进行中，loaded 以轮询为准）",
      content: { "application/json": { schema: statusSchema } },
    },
  },
});

const sleepRoute = createRoute({
  method: "post",
  path: "/sleep",
  tags: [API_TAGS.llm],
  operationId: "sleepLlm",
  summary:
    "一键关闭：卸载配置模型并停止本机 Ollama 服务（wake 的镜像操作；云端端点仅回探，停完回探呈现真实状态）",
  responses: {
    200: {
      description: "关闭后的最新状态（典型为红灯未连接或黄灯待机）",
      content: { "application/json": { schema: statusSchema } },
    },
  },
});

/** SSE 事件负载：引擎状态机快照（phase 过渡态 + status + error/notice） */
const engineSnapshotSchema = z.object({
  phase: z.enum(["idle", "starting", "stopping"]),
  progress: z.string().optional(),
  status: statusSchema,
  error: z.string().optional(),
  notice: z.string().optional(),
});

const streamRoute = createRoute({
  method: "get",
  path: "/stream",
  tags: [API_TAGS.llm],
  operationId: "streamLlmEvents",
  summary:
    "LLM 引擎状态 SSE 事件流（连接即推当前快照，变化才推；服务端仅在有订阅者时 30s 低频对账）",
  responses: {
    200: {
      description: "text/event-stream：event=status 携 EngineSnapshot JSON，event=ping 心跳保活",
      content: { "text/event-stream": { schema: engineSnapshotSchema } },
    },
  },
});

export const llm = new OpenAPIHono();

llm.openapi(statusRoute, async (c) => {
  const status = await probeLlm();
  return c.json(status, 200);
});

llm.openapi(wakeRoute, async (c) => {
  const status = await wakeEngine();
  return c.json(status, 200);
});

llm.openapi(sleepRoute, async (c) => {
  const status = await sleepEngine();
  return c.json(status, 200);
});

llm.openapi(streamRoute, (c) => {
  c.header("Cache-Control", "no-cache");
  // 经 nginx/反代时禁用缓冲，事件实时达浏览器（配套 location 级 proxy_buffering off 双保险）
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: string) => stream.writeSSE({ event, data });
    const unsubscribe = subscribeLlmEvents((snap) => {
      void send("status", JSON.stringify(snap)).catch(() => {
        // 写失败 = 连接已断，交给 abort 流程收尾
      });
    });
    try {
      await send("status", JSON.stringify(getLlmEngineSnapshot()));
      // 心跳：防代理空闲断连；客户端 EventSource 自带断线重连
      while (!stream.aborted) {
        await stream.sleep(25_000);
        if (stream.aborted) break;
        try {
          await send("ping", String(Date.now()));
        } catch {
          break; // 写失败 = 连接已断，退出循环走 finally 退订
        }
      }
    } finally {
      unsubscribe();
    }
  });
});
