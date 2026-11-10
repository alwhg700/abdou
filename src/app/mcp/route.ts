// خادم MCP على المسار /mcp — نقل Streamable HTTP وفق مواصفات MCP
// يستخدم SDK الرسمي: WebStandardStreamableHTTPServerTransport (يعمل مباشرة مع Web Request/Response
// في Next.js App Router — بلا تحويل يدوي) + McpServer لتسجيل الأدوات (لا JSON-RPC يدوي)
// 5 أدوات: generate_image / generate_video / merge_videos / get_task / list_media
// نتائج الاستدعاء تُصاغ بالعربية؛ أوصاف الأدوات بالإنجليزية (العميل يقرأها)
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { runGeneration, refreshTask } from "@/lib/generation";
import { runMerge } from "@/lib/merger";
import { listRecentTasks, parseResultUrls, type TaskRow } from "@/lib/tasks";
import { type ToolPayload, type Notifier, noopNotifier } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تصل 240 ثانية — مدة موسعة للدالة
export const maxDuration = 300;

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// إدارة الجلسات في الذاكرة — المفاتيح هي mcp-session-id
interface SessionPair {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
}
const sessions = new Map<string, SessionPair>();
const STATELESS = process.env.MCP_STATELESS === "1";
const MAX_SESSIONS = 200;

function requireAuth(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${token}`;
}

function jsonRpcError(status: number, code: number, message: string, id: unknown = null): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// بناء موجّه التقدم من extra — يرسل notifications/progress كل ~3 ثوانٍ فقط إن وُجد progressToken
function makeNotifier(extra: unknown): Notifier {
  const ex = extra as
    | { sendNotification?: (n: unknown) => Promise<void>; _meta?: { progressToken?: unknown } }
    | undefined;
  const token = ex?._meta?.progressToken;
  if (!token || typeof ex?.sendNotification !== "function") return noopNotifier;
  let last = 0;
  return async (progress: number, total: number, message: string) => {
    const now = Date.now();
    if (now - last < 2500) return;
    last = now;
    try {
      await ex.sendNotification!({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch {
      /* لا تعطل المهمة بسبب فشل إشعار */
    }
  };
}

function toToolResult(payload: ToolPayload) {
  return {
    content: [{ type: "text" as const, text: payload.text }],
    ...(payload.isError ? { isError: true } : {}),
  };
}

function fmtMediaList(tasks: TaskRow[]): ToolPayload {
  if (!tasks.length) return { text: "📜 لا توجد وسائط مخزنة بعد." };
  const lines: string[] = [`📜 أحدث الوسائط المخزنة (${tasks.length}):`];
  tasks.forEach((t, i) => {
    const typeLabel = t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
    const statusLabel = t.status === "completed" ? "✅ مكتملة" : t.status === "failed" ? "❌ فاشلة" : "⏳ جارية";
    const urls = parseResultUrls(t);
    lines.push(`\n${i + 1}. [${typeLabel}] ${statusLabel} — task_id: ${t.id}`);
    lines.push(`   الموديل: ${t.model} | أُنشئت: ${t.created_at} UTC`);
    if (t.prompt) lines.push(`   الوصف: ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? "…" : ""}`);
    if (urls.length) lines.push(`   الروابط:\n${urls.map((u) => `   - ${u}`).join("\n")}`);
    if (t.status === "failed" && t.error_message) lines.push(`   الخطأ: ${t.error_message}`);
  });
  return { text: lines.join("\n") };
}

// إنشاء زوج خادم/نقل جديد وتسجيل الأدوات الخمس
function createServerPair(): SessionPair {
  const sessionId = STATELESS ? undefined : randomUUID();
  const server = new McpServer(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: { listChanged: false } },
    }
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). Returns the ready image URL if generation finishes within the wait window; otherwise returns a task_id — call get_task with it every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => toToolResult(await runGeneration("image", args, makeNotifier(extra)))
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synced audio: dialogue/effects/music, optional image-to-video). Video takes minutes: short wait with live progress streaming, then a task_id is returned — track it with get_task every ~10 seconds until completed, then show the URL.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().describe("Optional public image URL as the first frame (image-to-video).").optional(),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => toToolResult(await runGeneration("video", args, makeNotifier(extra)))
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into one final video in the given order. Pass 'urls' (public direct video URLs — e.g. links returned by generate_video) or 'task_ids' (completed video generation tasks — their result URLs are resolved from the database in this order; ideal after generating several clips). Merging is usually fast: short wait with live progress, then a merge task_id is returned — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(
            z.string().min(1),
            // رسائل الرفض عربية مباشرة من المخطط (المعيار 9) مع بقاء الحدود في المخطط (المعيار 3)
            { message: "❌ urls يجب أن تكون مصفوفة روابط نصية." }
          )
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(
            z.string().min(1),
            { message: "❌ task_ids يجب أن تكون مصفوفة معرفات نصية." }
          )
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => toToolResult(await runMerge(args, makeNotifier(extra)))
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and updates live from the provider/merging service if still processing). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => toToolResult(await refreshTask(args.task_id))
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the latest stored images/videos/merges with their result URLs from the database (no regeneration) — use it to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      return toToolResult(fmtMediaList(tasks));
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: sessionId ? () => sessionId : undefined,
    onsessioninitialized: (sid) => {
      if (!sessions.has(sid)) {
        // (احتياطي) سجّل الجلسة إن لم تكن مسجلة من الحلقة الرئيسية
        sessions.set(sid, { server, transport, createdAt: Date.now() });
      }
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });

  void server.connect(transport);
  const pair: SessionPair = { server, transport, createdAt: Date.now() };
  if (sessionId) sessions.set(sessionId, pair);
  return pair;
}

// تنظيف الجلسات القديمة (أكثر من 24 ساعة) وتجاوز الحد الأقصى
function pruneSessions() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [sid, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(sid);
  }
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [sid] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(sid);
  }
}

export async function POST(req: Request) {
  if (!requireAuth(req)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer realm=/mcp" } });
  }

  // تحليل جسم JSON-RPC مسبقًا — نمرره كـ parsedBody للنقل الرسمي
  let parsedBody: unknown;
  try {
    const text = await req.text();
    parsedBody = text ? JSON.parse(text) : undefined;
  } catch {
    return jsonRpcError(400, -32700, "Parse error: جسم الطلب ليس JSON صالحًا");
  }
  if (parsedBody === undefined) {
    return jsonRpcError(400, -32600, "Invalid Request: جسم فارغ");
  }

  const isInit =
    typeof parsedBody === "object" &&
    parsedBody !== null &&
    (parsedBody as { method?: string }).method === "initialize";

  const sidHeader = req.headers.get("mcp-session-id");
  let pair: SessionPair | null = null;

  if (!STATELESS && sidHeader) {
    const found = sessions.get(sidHeader);
    if (!found) return jsonRpcError(404, -32001, "Session not found: أعد التهيئة initialize أولًا");
    pair = found;
  } else if (!STATELESS && !isInit) {
    return jsonRpcError(400, -32600, "Invalid Request: مطلوب initialize أولًا للحصول على mcp-session-id");
  } else {
    pruneSessions();
    pair = createServerPair();
  }

  try {
    // النقل الرسمي يعيد Response ويبًا جاهزًا — يدعم SSE الحي (Progress notifications) تلقائيًا
    return await pair.transport.handleRequest(req, { parsedBody });
  } catch (e) {
    return jsonRpcError(500, -32603, `Internal error: ${(e as Error)?.message || e}`);
  }
}

export async function DELETE(req: Request) {
  if (!requireAuth(req)) return new Response("Unauthorized", { status: 401 });
  const sidHeader = req.headers.get("mcp-session-id");
  if (STATELESS || !sidHeader) return new Response(null, { status: 405 });
  const pair = sessions.get(sidHeader);
  if (!pair) return new Response(null, { status: 404 });
  try {
    return await pair.transport.handleRequest(req); // يغلق الجلسة ويستدعي onsessionclosed
  } catch {
    return new Response(null, { status: 204 });
  }
}

export async function GET() {
  // لا نقدم بثًا من السيرفر نحو العميل — مسموح بالرفض وفق مواصفات MCP
  return jsonRpcError(405, -32000, "Method Not Allowed: GET SSE غير مدعوم على هذا الخادم");
}
