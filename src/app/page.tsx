"use client";

// لوحة الإدارة العربية RTL — صفحة واحدة بثلاث بطاقات:
// (أ) مدير المفاتيح (ب) لوحة المهام الحية (ج) ربط السيرفر بأي عميل MCP
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Copy, Check, KeyRound, Activity, Plug, Plus, Trash2, Power, PowerOff, RefreshCw,
  ExternalLink, ImageIcon, Film, Merge, SearchCheck, FolderOpen, Database, ShieldCheck, ShieldAlert,
} from "lucide-react";

interface KeyItem {
  id: string; provider: string; label: string; masked_key: string; status: string;
  usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_error: string | null; created_at: string;
}
interface TaskItem {
  id: string; provider: string | null; model: string; type: string; prompt: string;
  status: string; progress: number; result_urls_json: string | null;
  error_message: string | null; attempts_json: string; created_at: string;
}
interface Health {
  ok: boolean; database: string; mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — قد تعيد الرابط فورًا أو task_id للتابع.", icon: ImageIcon },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن — تعيد task_id ويُتابع بـ get_task.", icon: Film },
  { name: "merge_videos", desc: "دمج 2–10 مقاطع في فيديو واحد نهائي بالترتيب المعطى.", icon: Merge },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وإظهار الروابط.", icon: SearchCheck },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا من قاعدة البيانات.", icon: FolderOpen },
];

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">مكتملة</Badge>;
  if (status === "failed") return <Badge className="bg-rose-500/15 text-rose-300 border-rose-500/30">فاشلة</Badge>;
  if (status === "processing") return <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse">جارية</Badge>;
  if (status === "exhausted") return <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">مستنزف</Badge>;
  if (status === "disabled") return <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30">معطّل</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">نشط</Badge>;
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5 border-white/15 bg-white/5 hover:bg-white/10"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          toast({ title: "تم النسخ ✅" });
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast({ title: "تعذّر النسخ", variant: "destructive" });
        }
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label || "نسخ"}
    </Button>
  );
}

export default function Home() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);

  const [mcpUrl, setMcpUrl] = useState("/mcp");

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const d = await r.json();
      setKeys(d.keys || []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const d = await r.json();
      setTasks(d.tasks || []);
      if (d.stats) setStats(d.stats);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadKeys();
    loadTasks();
    setMcpUrl(`${window.location.origin}/mcp`);
    const t = setInterval(loadTasks, 5000); // تحديث حي كل ~5 ثوانٍ
    const h = setInterval(loadHealth, 15000);
    return () => {
      clearInterval(t);
      clearInterval(h);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast({ title: d.error || "فشل إضافة المفتاح", variant: "destructive" });
      } else {
        toast({ title: "تمت إضافة المفتاح ✅ — سيُجرَّب أولًا في المهام القادمة" });
        setApiKey("");
        setLabel("");
        loadKeys();
      }
    } finally {
      setAdding(false);
    }
  };

  const toggleKey = async (k: KeyItem) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    loadKeys();
  };

  const deleteKey = async (k: KeyItem) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "حُذف المفتاح" });
    loadKeys();
  };

  // إعدادات الربط الجاهزة لكل عميل
  const authHeaders = health?.authRequired ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } : undefined;
  const chatgptJson = useMemo(
    () => JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl, ...(authHeaders ? { headers: authHeaders } : {}) } } }, null, 2),
    [mcpUrl, health?.authRequired]
  );
  const claudeJson = useMemo(
    () => JSON.stringify({ mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...(authHeaders ? { headers: authHeaders } : {}) } } }, null, 2),
    [mcpUrl, health?.authRequired]
  );
  const cursorJson = claudeJson;

  const parseUrls = (t: TaskItem): string[] => {
    try {
      const v = JSON.parse(t.result_urls_json || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const attemptsCount = (t: TaskItem): number => {
    try {
      const v = JSON.parse(t.attempts_json || "[]");
      return Array.isArray(v) ? v.length : 0;
    } catch {
      return 0;
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a12] text-zinc-100" dir="rtl">
      {/* تدرج خلفي سماوي/بنفسجي هادئ */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(60rem_30rem_at_80%_-10%,rgba(139,92,246,0.14),transparent),radial-gradient(50rem_25rem_at_10%_0%,rgba(34,211,238,0.10),transparent)]" />

      <main className="relative mx-auto max-w-6xl px-4 py-8 space-y-6">
        {/* الترويسة */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">🎙️ MCP Media Generator</h1>
            <p className="text-sm text-zinc-400 mt-1">
              خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={
                health?.database === "turso-connected"
                  ? "gap-1.5 bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : "gap-1.5 bg-rose-500/15 text-rose-300 border-rose-500/30"
              }
            >
              <Database className="size-3.5" />
              {health?.database === "turso-connected" ? "Turso متصل" : "غير متصل"}
            </Badge>
            <Badge
              className={
                health?.merger?.healthy
                  ? "gap-1.5 bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : "gap-1.5 bg-amber-500/15 text-amber-300 border-amber-500/30"
              }
            >
              <Merge className="size-3.5" />
              خدمة الدمج: {health?.merger?.healthy ? "جاهزة" : "غير متاحة"}
            </Badge>
            <Badge className={health?.authRequired ? "gap-1.5 bg-amber-500/15 text-amber-300 border-amber-500/30" : "gap-1.5 bg-emerald-500/15 text-emerald-300 border-emerald-500/30"}>
              {health?.authRequired ? <ShieldAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
              {health?.authRequired ? "محمي بـ Bearer Token" : "بدون توثيق"}
            </Badge>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* (أ) مدير المفاتيح */}
          <Card className="border-white/10 bg-white/[0.04] backdrop-blur text-zinc-100">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <KeyRound className="size-5 text-violet-300" />
                مدير المفاتيح
              </CardTitle>
              <CardDescription className="text-zinc-400 leading-relaxed">
                أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي
                خطأ أو نفاد رصيد دون توقف.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger className="w-full bg-white/5 border-white/15">
                    <SelectValue placeholder="المزود" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="تسمية اختيارية (مثل: حساب رئيسي)"
                  className="bg-white/5 border-white/15"
                />
              </div>
              <div className="flex gap-2">
                <Input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="الصق مفتاح API هنا…"
                  className="bg-white/5 border-white/15 font-mono text-sm"
                  dir="ltr"
                  onKeyDown={(e) => e.key === "Enter" && addKey()}
                />
                <Button onClick={addKey} disabled={adding} className="gap-1.5 bg-violet-600 hover:bg-violet-500 shrink-0">
                  <Plus className="size-4" /> إضافة
                </Button>
              </div>

              <div className="max-h-96 overflow-y-auto space-y-2 pl-1 [scrollbar-width:thin]">
                {keys.length === 0 && (
                  <p className="text-sm text-zinc-500 py-6 text-center">لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد.</p>
                )}
                {keys.map((k) => (
                  <div key={k.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusBadge status={k.status} />
                        <span className="font-mono text-sm text-zinc-200" dir="ltr">{k.masked_key}</span>
                        <Badge variant="outline" className="border-white/15 text-zinc-300">{k.provider}</Badge>
                        {k.label && <span className="text-xs text-zinc-400 truncate">{k.label}</span>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button size="icon" variant="ghost" className="size-8 text-zinc-400 hover:text-zinc-100" title={k.status === "disabled" ? "تنشيط" : "تعطيل"} onClick={() => toggleKey(k)}>
                          {k.status === "disabled" ? <Power className="size-4" /> : <PowerOff className="size-4" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8 text-rose-400 hover:text-rose-300" title="حذف" onClick={() => deleteKey(k)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                      <span>استخدام: <b className="text-zinc-200">{k.usage_count}</b></span>
                      <span>نجاح: <b className="text-emerald-300">{k.success_count}</b></span>
                      <span>فشل: <b className="text-rose-300">{k.fail_count}</b></span>
                      <span>أُضيف: {new Date(k.created_at + "Z").toLocaleString("ar", { hour12: false })}</span>
                    </div>
                    {k.last_error && (
                      <p className="text-xs text-rose-300/80 truncate" title={k.last_error}>
                        آخر خطأ: {k.last_error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* (ب) لوحة المهام */}
          <Card className="border-white/10 bg-white/[0.04] backdrop-blur text-zinc-100">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2 text-lg">
                <span className="flex items-center gap-2">
                  <Activity className="size-5 text-cyan-300" />
                  لوحة المهام
                </span>
                <Button size="sm" variant="outline" className="gap-1 border-white/15 bg-white/5" onClick={loadTasks}>
                  <RefreshCw className="size-3.5" /> تحديث
                </Button>
              </CardTitle>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="outline" className="border-white/15 text-zinc-300">الإجمالي: {stats.total}</Badge>
                <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">مكتملة: {stats.completed}</Badge>
                <Badge className="bg-rose-500/15 text-rose-300 border-rose-500/30">فاشلة: {stats.failed}</Badge>
                <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">جارية: {stats.processing}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-h-96 overflow-y-auto space-y-2 pl-1 [scrollbar-width:thin]">
                {tasks.length === 0 && (
                  <p className="text-sm text-zinc-500 py-6 text-center">لا توجد مهام بعد — ابدأ التوليد من أي عميل MCP.</p>
                )}
                {tasks.map((t) => {
                  const urls = parseUrls(t);
                  return (
                    <div key={t.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={t.status} />
                          <Badge variant="outline" className="border-white/15 text-zinc-300">
                            {t.type === "image" ? "🖼️ صورة" : t.type === "video" ? "🎬 فيديو" : "🔗 دمج"}
                          </Badge>
                          <span className="text-xs text-zinc-500 font-mono" dir="ltr">{t.model}</span>
                        </div>
                        <span className="text-xs text-zinc-500">{new Date(t.created_at + "Z").toLocaleString("ar", { hour12: false })}</span>
                      </div>
                      {t.prompt && <p className="text-sm text-zinc-300 truncate" title={t.prompt}>{t.prompt}</p>}
                      {(t.status === "processing" || t.status === "pending") && <Progress value={t.progress} className="h-1.5" />}
                      {t.status === "failed" && t.error_message && (
                        <p className="text-xs text-rose-300/90">{t.error_message}</p>
                      )}
                      {urls.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {urls.map((u, i) => (
                            <a key={i} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200 underline underline-offset-4 break-all" dir="ltr">
                              <ExternalLink className="size-3 shrink-0" /> فتح الرابط {urls.length > 1 ? `(${i + 1})` : ""}
                            </a>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span className="font-mono truncate" dir="ltr">task_id: {t.id}</span>
                        <span>محاولات: {attemptsCount(t)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* (ج) ربط السيرفر */}
        <Card className="border-white/10 bg-white/[0.04] backdrop-blur text-zinc-100">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Plug className="size-5 text-violet-300" />
              ربط السيرفر بأي عميل MCP
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input readOnly value={mcpUrl} dir="ltr" className="bg-white/5 border-white/15 font-mono text-sm" />
              <CopyBtn text={mcpUrl} label="نسخ الرابط" />
            </div>

            <Tabs defaultValue="chatgpt" dir="rtl">
              <TabsList className="bg-white/5 border border-white/10">
                <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-sm text-zinc-400">
                  في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
                </p>
                <div className="relative">
                  <pre className="rounded-lg border border-white/10 bg-black/40 p-4 text-xs font-mono overflow-x-auto text-zinc-200" dir="ltr">{chatgptJson}</pre>
                  <div className="absolute top-2 left-2"><CopyBtn text={chatgptJson} /></div>
                </div>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-sm text-zinc-400">الصق هذا في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.</p>
                <div className="relative">
                  <pre className="rounded-lg border border-white/10 bg-black/40 p-4 text-xs font-mono overflow-x-auto text-zinc-200" dir="ltr">{claudeJson}</pre>
                  <div className="absolute top-2 left-2"><CopyBtn text={claudeJson} /></div>
                </div>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-sm text-zinc-400">الصق هذا في ملف mcp.json (Cursor / Windsurf / Cline) ثم أعد التشغيل.</p>
                <div className="relative">
                  <pre className="rounded-lg border border-white/10 bg-black/40 p-4 text-xs font-mono overflow-x-auto text-zinc-200" dir="ltr">{cursorJson}</pre>
                  <div className="absolute top-2 left-2"><CopyBtn text={cursorJson} /></div>
                </div>
              </TabsContent>
            </Tabs>

            {/* رقائق الأدوات الخمس */}
            <div>
              <h3 className="text-sm font-semibold text-zinc-300 mb-2">الأدوات الخمس المتاحة للعميل</h3>
              <div className="flex flex-wrap gap-2">
                {TOOLS.map((tool) => (
                  <div key={tool.name} className="group flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 max-w-full">
                    <tool.icon className="size-4 mt-0.5 text-violet-300 shrink-0" />
                    <div className="min-w-0">
                      <code className="text-xs font-semibold text-cyan-200" dir="ltr">{tool.name}</code>
                      <p className="text-xs text-zinc-400 leading-relaxed">{tool.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ملاحظة كهرمانية */}
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200 leading-relaxed">
              ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
              العملية.
            </div>
          </CardContent>
        </Card>

        <footer className="pt-2 pb-6 text-center text-xs text-zinc-500">
          MCP Media Generator v1.2.0 — روابط فقط: لا تُخزَّن أي ملفات وسائط على السيرفر — المفاتيح مقنّعة دائمًا.
        </footer>
      </main>
    </div>
  );
}
