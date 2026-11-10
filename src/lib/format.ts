// صياغة الردود العربية لأدوات MCP — كل رسائل الأدوات بالعربية
// (المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية)
import type { TaskRow } from "./tasks";
import { parseResultUrls } from "./tasks";

export type Notifier = (progress: number, total: number, message: string) => Promise<void>;

export const noopNotifier: Notifier = async () => {};

export interface ToolPayload {
  text: string;
  isError?: boolean;
}

export function fmtImageCompleted(urls: string[]): ToolPayload {
  const first = urls[0];
  const more = urls.length > 1 ? `\n\nروابط إضافية:\n${urls.slice(1).join("\n")}` : "";
  return {
    text: `✅ تم توليد الصورة بنجاح\n\n![image](${first})\n\nالرابط المباشر: ${first}${more}`,
  };
}

export function fmtVideoCompleted(urls: string[]): ToolPayload {
  const list = urls.map((u) => `- ${u}`).join("\n");
  return {
    text: `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر:\n${list}`,
  };
}

export function fmtMergeCompleted(urls: string[]): ToolPayload {
  const list = urls.map((u) => `- ${u}`).join("\n");
  return {
    text: `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر:\n${list}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
  };
}

export function fmtProcessing(task: TaskRow): ToolPayload {
  const pct = typeof task.progress === "number" && task.progress > 0 ? `\nالتقدم الحالي: ${task.progress}%` : "";
  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n${pct}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

export function fmtFailed(reason: string): ToolPayload {
  return { text: `❌ فشلت المهمة: ${reason}`, isError: true };
}

export function fmtNotFound(taskId: string): ToolPayload {
  return { text: `❌ لم يتم العثور على مهمة بهذا المعرّف: ${taskId}`, isError: true };
}

export function fmtNoKeys(model: string): ToolPayload {
  return {
    text: `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    isError: true,
  };
}

export function fmtUnknownModel(name: string): ToolPayload {
  return {
    text: `❌ موديل غير معروف: ${name}. الموديلات المتاحة: gpt-image-2-6/flare-text-to-image (صور)، grok-imagine-video-1-5-preview (فيديو).`,
    isError: true,
  };
}

export function fmtMergeNeedsTwo(details?: string): ToolPayload {
  return {
    text: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${details ? `\n\nتفاصيل المعرفات:\n${details}` : ""}`,
    isError: true,
  };
}

export function fmtMergeMaxTen(): ToolPayload {
  return {
    text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    isError: true,
  };
}

export function fmtMergeNotPublic(url: string): ToolPayload {
  return {
    text: `❌ يجب أن تكون جميع الروابط روابط فيديو مباشرة وعامة (http/https). رُفض الرابط: ${url}`,
    isError: true,
  };
}

export function fmtMerge24hGone(): ToolPayload {
  return {
    text: "❌ فشلت المهمة: مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
    isError: true,
  };
}

// صياغة جاهزة حسب حالة المهمة — تُستخدم في get_task و list_media
export function fmtTaskStatus(task: TaskRow): ToolPayload {
  const urls = parseResultUrls(task);
  const typeLabel = task.type === "image" ? "صورة" : task.type === "video" ? "فيديو" : "دمج مقاطع";
  if (task.status === "completed" && urls.length) {
    const list = urls.map((u) => `- ${u}`).join("\n");
    const warn = task.type === "merge" ? "\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا." : "";
    return {
      text: `✅ المهمة مكتملة (${typeLabel})\n\nالروابط:\n${list}${warn}`,
    };
  }
  if (task.status === "failed") {
    return { text: `❌ فشلت المهمة: ${task.error_message || "سبب غير معروف"}`, isError: true };
  }
  return fmtProcessing(task);
}
