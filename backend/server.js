import express from "express";
import cors from "cors";
import net from "net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { query } from "@tencent-ai/agent-sdk";

dotenv.config();

// 定位官方 codebuddy CLI（@tencent-ai/codebuddy-code）。SDK 的 query() 通过 stdio 拉起它，
// 必须用官方 CLI（含 SDK 期望的 dist/codebuddy-headless.js），不能用 WorkBuddy 自带那份。
// 解析优先级：① 显式 CODEBUDDY_CLI_PATH → ② PATH 上的 codebuddy → ③ 受管 node 目录下的固定路径。
function resolveCli() {
  if (process.env.CODEBUDDY_CLI_PATH) return process.env.CODEBUDDY_CLI_PATH;
  try {
    const r = spawnSync("codebuddy", ["--version"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && (r.stdout || "").includes(".")) return "codebuddy";
  } catch (_) {}
  const candidates = [
    path.join(
      os.homedir(),
      ".workbuddy/binaries/node/versions/22.22.2/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"
    ),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "codebuddy"; // 最后兜底，让 SDK 报错时给出清晰信息
}

// 官方 codebuddy CLI 启动时会起一个 prewarm 本地 server，端口由 SERVER__PORT 控制。
// 本机 WorkBuddy 桌面应用自身也会起 serve/prewarm 实例占同类端口，两者撞车会导致
// CLI 一启动就 EADDRINUSE 挂起（表现为 SDK query() 永远 0 字节超时）。
// 这里在后端启动时分配一个空闲端口并注入环境，让 SDK 拉起的 CLI 用独立端口，避开冲突。
// 也可在 .env 里手动指定 SERVER__PORT=<port> 覆盖。
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
if (!process.env.SERVER__PORT) {
  process.env.SERVER__PORT = String(await getFreePort());
}

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CODEBUDDY_API_KEY || "";
const MODEL = process.env.CODEBUDDY_MODEL || "hy3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
// 托管模式：由扩展(webchat:// 协议)拉起时为 1。此时后端生命周期交给「扩展心跳」——
// 浏览器开着→扩展持续 ping 心跳→后端存活；浏览器关→扩展服务线程回收→心跳断→后端自退。
// 此模式下完全不需要知道浏览器进程名，任意 Chromium 内核通用。
const MANAGED = process.env.WEBCHAT_MANAGED === "1";
// @tencent-ai/agent-sdk 的 query() 需要本地有 codebuddy CLI 子进程（transport 通过 stdio 拉起它）。
// 必须用 SDK 配套的官方 CLI（@tencent-ai/codebuddy-code），它有 SDK 期望的 dist/codebuddy-headless.js 入口；
// 不能用 WorkBuddy 自带的那份 cli/dist/codebuddy.js（v2.106，与 SDK 协议不匹配，会 initialize 超时）。
const CODEBUDDY_CLI = resolveCli();

// 中国版必须设置该环境变量，否则默认走海外网关会拒绝国内 key（initialize 握手失败）。
if (!process.env.CODEBUDDY_INTERNET_ENVIRONMENT) {
  process.env.CODEBUDDY_INTERNET_ENVIRONMENT = "internal";
}

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  })
);
app.use(express.json());

// 健康检查：顺便告诉前端当前是真实模式还是演示模式
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mode: API_KEY ? "real" : "demo",
    model: MODEL,
    serverPort: process.env.SERVER__PORT,
    managed: MANAGED,
    ts: new Date().toISOString(),
  });
});

// 心跳：仅托管模式(MANAGED=1)使用。扩展的 background.js 用 chrome.alarms 周期性调用本端点；
// 后端记录 lastHeartbeat，若超过 HEARTBEAT_TTL 没收到心跳(=浏览器已关)，自行优雅退出。
app.post("/api/heartbeat", (req, res) => {
  lastHeartbeat = Date.now();
  res.json({ status: "ok", managed: MANAGED, ttl: HEARTBEAT_TTL });
});

// 构造系统提示：把网页上下文塞进去，让 AI 知道用户在看什么
function buildSystemPrompt(context, pageTitle, pageUrl) {
  const ctxBlock =
    context && context.trim()
      ? `\n\n【用户当前正在浏览的网页上下文】\n网页标题：${
          pageTitle || "未知"
        }\n网页地址：${pageUrl || "未知"}\n用户选中的内容：\n"""\n${context.trim()}\n"""\n请基于以上网页内容回答用户问题；若问题与上下文无关，也可正常回答。`
      : "";
  return (
    '你是"小虾"，一个中文 AI 助手，风格简洁、直接、有帮助。回答用中文。' +
    ctxBlock
  );
}

// 把多轮历史 + 当前问题拼成单轮 prompt（无状态，最简单稳）
function buildUserPrompt(question, history) {
  let p = "";
  if (Array.isArray(history) && history.length) {
    p += "【对话历史】\n";
    for (const m of history) {
      p += (m.role === "assistant" ? "小虾" : "用户") + "：" + m.content + "\n";
    }
    p += "\n";
  }
  p += "【当前问题】\n" + (question || "");
  return p;
}

// 演示模式：没有 API Key 时，模拟流式打字机回复，方便验收交互闭环
async function streamDemo(res, ctx, question) {
  const snippet = (ctx || "").trim().slice(0, 100);
  const reply =
    `（演示模式 · 未配置 CODEBUDDY_API_KEY）\n\n` +
    `我读到了你在网页上选中的内容：\n「${snippet}${
      ctx && ctx.length > 100 ? "…" : ""
    }」\n\n` +
    `你的问题是：「${question}」\n\n` +
    `这是一段模拟回复，用来验收「划线 → 唤起对话 → 流式显示」的闭环是否正常。\n` +
    `配置好 API Key 后，这里就会变成真实的 AI 回答 🦐`;
  const chunks = reply.match(/[\s\S]{1,12}/g) || [reply];
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify({ type: "text", content: c })}\n\n`);
    await new Promise((r) => setTimeout(r, 22));
  }
  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
}

// 核心：网页划线对话接口（SSE 流式）
app.post("/api/chat", async (req, res) => {
  const {
    context = "",
    question = "",
    history = [],
    pageTitle = "",
    pageUrl = "",
  } = req.body || {};

  if (!question && !context) {
    return res.status(400).json({ error: "question 或 context 不能为空" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 演示模式
  if (!API_KEY) {
    res.write(`data: ${JSON.stringify({ type: "init", mode: "demo" })}\n\n`);
    await streamDemo(res, context, question);
    return res.end();
  }

  // 真实模式
  res.write(
    `data: ${JSON.stringify({ type: "init", mode: "real", model: MODEL })}\n\n`
  );
  const systemPrompt = buildSystemPrompt(context, pageTitle, pageUrl);
  const prompt = buildUserPrompt(question, history);
  const canUseTool = async () => ({
    behavior: "deny",
    message: "本插件仅做文本问答，不允许使用工具",
  });

  try {
    const stream = query({
      prompt,
      options: {
        cwd: process.cwd(),
        model: MODEL,
        maxTurns: 5,
        systemPrompt,
        permissionMode: "default",
        canUseTool,
        pathToCodebuddyCode: CODEBUDDY_CLI,
      },
    });

    for await (const msg of stream) {
      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (typeof content === "string") {
          res.write(
            `data: ${JSON.stringify({ type: "text", content })}\n\n`
          );
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && block.text) {
              res.write(
                `data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`
              );
            }
          }
        }
      } else if (msg.type === "result") {
        res.write(
          `data: ${JSON.stringify({
            type: "done",
            duration: msg.duration_ms || msg.duration,
          })}\n\n`
        );
      }
    }
    res.end();
  } catch (err) {
    console.error("[chat] error:", err?.message || err);
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        message: err?.message || "调用 AI 失败",
      })}\n\n`
    );
    res.end();
  }
});

// 优雅停止：面板点「停止后端」时调用，进程自行退出（无需关终端/任务管理器）
app.post("/api/stop", (req, res) => {
  res.json({ status: "stopping" });
  // 给响应一点时间 flush 后再退出
  setTimeout(() => {
    process.exit(0);
  }, 300);
});

// 空闲自动退出：启动后若连续 IDLE_TIMEOUT_MIN 分钟无任何请求，自动退出。
// 目的：用户用完关闭浏览器后，常驻后端不会一直占资源（不常驻策略的兜底）。
const IDLE_TIMEOUT_MIN = Number(process.env.IDLE_TIMEOUT_MIN || 30);
let idleTimer = null;
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(`\n[idle] ${IDLE_TIMEOUT_MIN} 分钟无请求，自动退出后端。`);
    process.exit(0);
  }, IDLE_TIMEOUT_MIN * 60 * 1000);
}
resetIdleTimer();
// 所有请求都重置空闲计时（health / chat / stop）
app.use((req, res, next) => {
  if (req.path !== "/api/stop") resetIdleTimer();
  next();
});

// ---------- 托管模式心跳看门狗 ----------
// 心跳宽限：扩展闹钟约每 60s 一次，这里给 2.5 分钟宽限，避免 SW 节流误杀。
const HEARTBEAT_TTL = Number(process.env.HEARTBEAT_TTL || 150000);
let lastHeartbeat = Date.now(); // 托管模式下，以启动时刻为初始心跳
function startHeartbeatWatchdog() {
  setInterval(() => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_TTL) {
      console.log(
        `\n[heartbeat] ${HEARTBEAT_TTL}ms 内未收到扩展心跳（浏览器已关闭？），自动退出后端。`
      );
      process.exit(0);
    }
  }, 5000);
  console.log(`  托管模式：靠扩展心跳续命，心跳断 ${HEARTBEAT_TTL}ms 后自退（跨浏览器通用，无需进程名）`);
}

app.listen(PORT, () => {
  console.log(`\n◉ 网页划线对话后端已启动: http://localhost:${PORT}`);
  console.log(
    `  模式: ${
      API_KEY
        ? "真实 AI（CODEBUDDY_API_KEY 已配置）"
        : "演示模式（未配置 API Key，可验收交互，但无真实回答）"
    }`
  );
  console.log(`  CLI prewarm 端口 SERVER__PORT=${process.env.SERVER__PORT}（避开 WorkBuddy 端口冲突）`);
  console.log(`  空闲 ${IDLE_TIMEOUT_MIN} 分钟自动退出（可设 IDLE_TIMEOUT_MIN 调整）`);
  if (MANAGED) startHeartbeatWatchdog();
  console.log("");
});
