// سجل الموديلات — الاسم الموحد (canonical) + الصيغ البديلة المقبولة + المزودون
import type { ProviderId } from "./keys";

export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

// الأسماء قابلة للتجاوز بمتغيرات البيئة
const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-26/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-15-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

// توحيد الاسم: نقاط → شرطات داخل الأرقام (gpt-image-2.6/… → gpt-image-2-6/…)
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/(\d)\.(\d)/g, "$1-$2");
}

export function normalizeModel(name?: string | null): ModelDef | null {
  if (!name) return null;
  const n = normalizeName(name);
  for (const m of MODELS) {
    if (normalizeName(m.canonical) === n) return m;
    if (m.aliases.some((a) => normalizeName(a) === n)) return m;
  }
  return null;
}

export function findModelByCanonical(canonical: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === canonical) ?? null;
}

export function modelProviderModel(m: ModelDef, p: ProviderId): string {
  return m.providerModel[p] || m.canonical;
}
