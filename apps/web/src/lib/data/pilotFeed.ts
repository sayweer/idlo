import { z } from "zod";
import {
  OptionIdSchema,
  TRACE_MODES,
  TraceSchema,
  UnixMsSchema,
  WEATHER_SOURCES,
  WeatherSchema,
  KullaniciyaSorInputSchema,
} from "@pilot/shared";
import { feedMode } from "./mode";

/**
 * PİLOT besleme zarfı (UI_HANDOFF §4). TODO(spec): Barış ile kesinleştir, shared'e taşı.
 * Mevcut shared şemalarını sarmalar; hangi alanın DUVAR saati, hangisinin simüle (KAYIT) saat olduğu sabittir.
 */
export const PilotFeedSchema = z.strictObject({
  generatedAt: UnixMsSchema, // DUVAR saati; bayatlık bununla ölçülür
  pilot: z.strictObject({
    alive: z.boolean(), // nabız
    mode: z.enum(TRACE_MODES), // "llm" | "rules"
    injectionDemo: z.boolean(),
    src: z.enum(WEATHER_SOURCES), // "live" | "replay" → KAYIT
    replayDay: z.string().nullable(),
  }),
  weather: WeatherSchema.nullable(), // KAYIT'ta weather.ts simüle saat
  traces: z.array(TraceSchema), // son N tur, yeni → eski; KAYIT'ta ts simüle saat
  questions: z.array(
    z.strictObject({
      questionId: z.string(),
      soru: z.string(),
      secenekler: KullaniciyaSorInputSchema.shape.secenekler,
      defaultOptionId: OptionIdSchema, // zaman aşımında PİLOT'un uygulayacağı
      askedAt: UnixMsSchema, // DUVAR saati
      timeoutAt: UnixMsSchema, // DUVAR saati, askedAt + 2 sa
      answered: z.boolean(),
    }),
  ),
});
export type PilotFeed = z.infer<typeof PilotFeedSchema>;

/** Elif'in sorulara cevabı: yalnız bir seçenek kimliği (panele yürütme gücü vermez). */
export interface PilotAnswer {
  questionId: string;
  optionId: z.infer<typeof OptionIdSchema>;
}

/** Besleme kaynağı. `origin: "mock"` iken ekranda TEMSİLİ VERİ rozeti zorunludur. */
export interface PilotFeedSource {
  readonly origin: "mock" | "http";
  /** Doğrulanmış zarf. Ağ ya da şema hatasında fırlatır: ekran "bilinmiyor" (gri) gösterir, tahmin etmez. */
  read(user: string): Promise<PilotFeed>;
  /** İmzalı cevap gönderimi (TODO(spec): POST /api/pilot/answer, Barış). Mock'ta kabul edilmez. */
  answer?(a: PilotAnswer): Promise<void>;
}

/** Mock: sabit KAYIT hava durumu (NORMAL), iz ve soru yok. Ekranlar boş/bilinmiyor durumlarını bununla dener. */
export function createMockPilotFeed(): PilotFeedSource {
  return {
    origin: "mock",
    async read() {
      return PilotFeedSchema.parse({
        generatedAt: Date.now(),
        pilot: { alive: true, mode: "rules", injectionDemo: false, src: "replay", replayDay: "2025-03-19" },
        weather: {
          ts: Date.UTC(2025, 2, 19, 7, 0, 0),
          px: 36.52,
          r1hBp: 4,
          med168Bp: 11,
          zd: 0.4,
          alarm: false,
          btc1h: 0.2,
          btc3h: 0.5,
          fxOpen: true,
          class: "NORMAL",
          stormUntil: null,
          episode: null,
          src: "replay",
        },
        traces: [],
        questions: [],
      });
    },
  };
}

/** Gerçek: sunucu tarafı vekil GET /api/pilot/feed?user= (PLANLI). Token tarayıcıya gitmez; yanıt zod ile doğrulanır. */
export function createHttpPilotFeed(base = "/api/pilot/feed"): PilotFeedSource {
  return {
    origin: "http",
    async read(user) {
      const res = await fetch(`${base}?user=${encodeURIComponent(user)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`PİLOT beslemesi okunamadı (HTTP ${res.status})`);
      return PilotFeedSchema.parse(await res.json());
    },
  };
}

export const pilotFeed: PilotFeedSource = feedMode === "http" ? createHttpPilotFeed() : createMockPilotFeed();
