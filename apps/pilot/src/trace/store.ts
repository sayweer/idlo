/**
 * PİLOT iz kaydı (§10.1, §15). Her tur bir satır (JSON Lines). Satırdaki `trace` alanı shared TraceSchema'dır
 * (panel bunu okur); yanındaki alanlar §15'te yoktur ama panelin göstermesi gerekir:
 * - `labels`: ekran etiketleri (CLAUDE.md kural 12: kural modu, enjeksiyon demosu, kâğıt emir, kayıt oynatma).
 * - `rejected`: §10.2 listesinde olmayan ya da tur sınırını aşan çağrılar. TraceStep.tool yalnız §10.2 adlarını
 *   kabul ettiği için bunlar adım değildir; ama izde görünürler ("bilinmeyen araç → kayıtlı hata, işlem yok").
 * - `end`: tur nasıl kapandı (bekle / bitir / kod kapattı) ve bir sonraki uyanma.
 * TODO(spec): §15 iz dosyasının yerini ve sarmalayıcı alanları tanımlamıyor; en dar seçim bu biçim.
 *
 * Kayıttan önce şema doğrulanır; geçmeyen kayıt yazılmaz ve hata fırlatılır (fail-closed).
 * İzde anahtar ya da token yoktur: yalnız araç girdileri/çıktıları ve gerekçeler (CLAUDE.md kural 5).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { TraceSchema, UnixMsSchema } from "@pilot/shared";

export const TRIGGERS = ["start", "tick", "alarm", "answer", "expiry"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TurnEndRecordSchema = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("bekle"), untilMs: UnixMsSchema, gerekce: z.string() }),
  z.strictObject({ by: z.literal("bitir"), ozet: z.string() }),
  /** LLM turu bekle/bitir ile kapatmadı ya da araç katmanı kapatamadı: kod bekletir (fail-closed). */
  z.strictObject({ by: z.literal("code"), untilMs: UnixMsSchema, gerekce: z.string() }),
]);
export type TurnEndRecord = z.infer<typeof TurnEndRecordSchema>;

export const RejectedCallSchema = z.strictObject({ tool: z.string().max(200), error: z.string().max(500) });
export type RejectedCall = z.infer<typeof RejectedCallSchema>;

export const TraceRecordSchema = z.strictObject({
  v: z.literal(1),
  trace: TraceSchema,
  labels: z.array(z.string()),
  trigger: z.enum(TRIGGERS),
  end: TurnEndRecordSchema,
  rejected: z.array(RejectedCallSchema),
  /** LLM modu denendi ama kullanılamadıysa kısa neden (anahtar/yanıt gövdesi yazılmaz). */
  llmError: z.string().max(300).optional(),
});
export type TraceRecord = z.infer<typeof TraceRecordSchema>;

export interface TraceStore {
  append(r: TraceRecord): Promise<void>;
  /** Son kaydın tur numarası; kayıt yoksa null (yeniden başlamada tur numarası sürer). */
  lastTurn(): Promise<number | null>;
}

export class MemoryTraceStore implements TraceStore {
  readonly records: TraceRecord[] = [];
  async append(r: TraceRecord): Promise<void> {
    this.records.push(TraceRecordSchema.parse(r));
  }
  async lastTurn(): Promise<number | null> {
    return this.records.at(-1)?.trace.turn ?? null;
  }
}

/** JSON Lines dosyası; her tur bir satır, ekleme kipinde. */
export class FileTraceStore implements TraceStore {
  constructor(readonly path: string) {}

  async append(r: TraceRecord): Promise<void> {
    const line = JSON.stringify(TraceRecordSchema.parse(r));
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line + "\n", "utf8");
  }

  async lastTurn(): Promise<number | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return null;
    }
    const last = text.trimEnd().split("\n").at(-1);
    if (!last) return null;
    // Bozuk son satır: tur numarasını uydurmayız, hata (fail-closed; dosyayı insan inceler).
    const bad = () => new Error(`İz dosyasının son satırı geçersiz: ${this.path}`);
    let json: unknown;
    try {
      json = JSON.parse(last);
    } catch {
      throw bad();
    }
    const parsed = TraceRecordSchema.safeParse(json);
    if (!parsed.success) throw bad();
    return parsed.data.trace.turn;
  }
}
