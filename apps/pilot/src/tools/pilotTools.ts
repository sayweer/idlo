/**
 * PİLOT araç katmanı (§10.2–§10.5, §16). LLM yalnız bu araçları görür (shared PILOT_TOOLS); KULE araçları
 * (kule_*) LLM'e hiç verilmez ve bu katman onları adla da çağırtmaz (CLAUDE.md kural 1).
 *
 * Her çağrı: araç adı §10.2 listesinde mi → girdi PILOT_TOOLS[ad].input ile doğrulanır → koruma → işlem →
 * çıktı PILOT_TOOLS[ad].output ile doğrulanır. Herhangi bir adım geçmezse işlem yapılmaz (fail-closed, kural 2).
 *
 * Korumalar (kod; LLM değiştiremez):
 * - Tur sınırı: en fazla 8 çağrı (§10.1); `bekle` ya da `bitir` turu kapatır, sonrasında çağrı yok.
 * - izin_iste: (tutar, tür) bu turdaki kural_danis `allowed` listesinde olmalı (§10.2, §10.5); izin anında tablo
 *   yeniden hesaplanır ve seçenek hâlâ izinli olmalı; aynı (tutar, tür) için bu turda ONAY'lı teklif_al olmalı ve
 *   maxPxE6 teklif fiyatını en fazla MAX_PX_OVER_QUOTE_BPS aşabilir; turda en fazla bir izin; kullanıcı yapılandırmadan
 *   sabit (ChainClient'ta kullanıcı parametresi yok). Demo modları bu korumaları kapatmaz (§10.5 v4.1, kural 12).
 * - emri_uygula: yalnız bu PİLOT'un izin_iste ile aldığı ve henüz uygulanmamış izin (haberdeki/uydurma actionId gitmez).
 * - kullaniciya_sor: yalnız tablo ASK'e izin verdiyse; seçenekler bu turdaki allowed listesinden (ASK hariç).
 * - haberleri_oku: çıktı her zaman `untrusted: true` (§10.5).
 * - bitir: yalnız tablo BITIR'e izin verdiyse.
 */
import { isAddressEqual, keccak256, stringToBytes } from "viem";
import type { z } from "zod";
import {
  MAX_TOOL_CALLS_PER_TURN,
  PILOT_TOOLS,
  PILOT_TOOL_NAMES,
  REJECT_TEXTS,
  buyOptionId,
  cycleIdOf,
  msToSec,
  pxToPxE6,
  trDay,
  type BekleInputSchema,
  type BitirInputSchema,
  type EmriUygulaInputSchema,
  type IzinIsteInputSchema,
  type IzinIsteOutputSchema,
  type KullaniciyaSorInputSchema,
  type KuralDanisOutput,
  type PilotToolName,
  type TeklifAlInputSchema,
  type Weather,
} from "@pilot/shared";
import { ChainError, type ChainClient } from "../clients/chain.js";
import type { Clock } from "../clients/clock.js";
import { KuleError, safeParseNoThrow, type KuleClient, type KuleOutput } from "../clients/kule.js";
import { kuralDanis } from "../rules/index.js";
import { NO_CALENDAR, NO_NEWS, type CalendarSource, type NewsSource, type WeatherSource } from "./sources.js";
import { PilotState } from "./state.js";

/**
 * izin_iste'de maxPxE6, bu turdaki teklif fiyatını en fazla bu kadar aşabilir.
 * TODO(spec): SPEC sınır vermiyor ("sayı uydurma; tutarları araç çıktılarından al", §10.2). En dar seçim KULE'nin
 * makas sınırı (§9.2-8: 30 bp); ioc'de fiyat bu arada yükselirse KULE BEKLET ABOVE_MAX_PX verir (fail-closed).
 */
export const MAX_PX_OVER_QUOTE_BPS = 30;
/** TODO(spec): haber akışı sınırları SPEC'te yok; bağlamı şişirmesin diye en dar makul sınırlar. */
export const NEWS_MAX_ITEMS = 20;
export const NEWS_MAX_TITLE = 300;
export const NEWS_MAX_BODY = 2000;
/** ekonomik_takvim: "önümüzdeki 24 saat" (§10.2). */
export const CALENDAR_HORIZON_MS = 24 * 3600 * 1000;
export const CALENDAR_MAX_EVENTS = 20;

/** §10.4 "yarısı alındı" kuralının geçtiği sınıflar (src/rules/decision.ts ile aynı). */
const HALF_CLASSES = new Set(["PRIM_SISMESI", "BELIRSIZ"]);

export interface PilotToolDeps {
  chain: ChainClient;
  kule: KuleClient;
  weather: WeatherSource;
  clock: Clock;
  news?: NewsSource;
  calendar?: CalendarSource;
  state?: PilotState;
}

export type TurnEnd = { tool: "bekle"; untilMs: number; gerekce: string } | { tool: "bitir"; ozet: string };

/** Bir araç çağrısının sonucu; §15 iz adımı (TraceStep) ile aynı alanlar. */
export type ToolCallResult =
  | { ok: true; tool: PilotToolName; in: Record<string, unknown>; out: unknown }
  | { ok: false; tool: string; in?: unknown; error: string };

/** Korumanın reddi: Türkçe mesaj LLM'e ve panele gider. */
class ToolRefusal extends Error {}

interface Advice {
  out: KuralDanisOutput;
  weather: Weather | null;
}

type In<S extends z.ZodType> = z.output<S>;
type IzinOut = z.input<typeof IzinIsteOutputSchema>;

function isPilotToolName(n: unknown): n is PilotToolName {
  return typeof n === "string" && (PILOT_TOOL_NAMES as readonly string[]).includes(n);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

export class PilotTools {
  readonly state: PilotState;
  constructor(private readonly deps: PilotToolDeps) {
    this.state = deps.state ?? new PilotState();
  }
  /** Yeni tur (§10.1): kural_danis çıktısı, teklifler ve çağrı sayısı tura özeldir. */
  beginTurn(): PilotTurn {
    return new PilotTurn(this.deps, this.state);
  }
}

export class PilotTurn {
  calls = 0;
  ended: TurnEnd | null = null;
  private advice: Advice | null = null;
  private readonly quotes = new Map<string, KuleOutput<"kule_quote">>();
  private authorized = false;
  private chainUncertain = false;
  private readonly news: NewsSource;
  private readonly calendar: CalendarSource;

  constructor(
    private readonly deps: PilotToolDeps,
    private readonly state: PilotState,
  ) {
    this.news = deps.news ?? NO_NEWS;
    this.calendar = deps.calendar ?? NO_CALENDAR;
  }

  /** Bu turda kural_danis'in son çıktısı (C5 kural modu ve iz için). */
  get lastAdvice(): KuralDanisOutput | null {
    return this.advice?.out ?? null;
  }

  async call(name: string, rawInput: unknown): Promise<ToolCallResult> {
    const fail = (error: string, input?: unknown): ToolCallResult => ({ ok: false, tool: String(name), in: input, error });
    if (this.ended) return fail(`Tur kapandı (${this.ended.tool}); yeni araç çağrısı yapılmaz.`);
    if (++this.calls > MAX_TOOL_CALLS_PER_TURN) return fail(`Bir turda en fazla ${MAX_TOOL_CALLS_PER_TURN} araç çağrısı yapılabilir.`);
    if (!isPilotToolName(name)) return fail("Bilinmeyen araç; yalnız PİLOT araçları kullanılabilir.");

    const def = PILOT_TOOLS[name];
    const parsed = safeParseNoThrow(def.input, rawInput);
    if (!parsed.success) {
      const why = (parsed.error?.issues ?? [{ path: [], message: "doğrulama hata verdi" }])
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`)
        .join("; ");
      return fail(`Girdi geçersiz: ${why}`, rawInput);
    }
    const input = parsed.data as Record<string, unknown>;
    try {
      const out = await this.run(name, input);
      const checked = safeParseNoThrow(def.output, out);
      if (!checked.success) return fail("Araç çıktısı doğrulanamadı; işlem yapılmadı.", input);
      return { ok: true, tool: name, in: input, out: checked.data };
    } catch (e) {
      if (e instanceof ToolRefusal) return fail(e.message, input);
      if (e instanceof KuleError) return fail("KULE'ye ulaşılamadı ya da yanıtı doğrulanamadı.", input);
      if (e instanceof ChainError) return fail("Zincir okunamadı ya da yazılamadı.", input);
      return fail("Araç hata verdi; işlem yapılmadı.", input);
    }
  }

  private run(name: PilotToolName, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "plan_oku":
        return this.planOku();
      case "hava_durumu":
        return this.deps.weather.current(this.deps.clock.nowMs());
      case "bakiye_oku":
        return this.deps.kule.balance();
      case "kural_danis":
        return this.kuralDanis();
      case "teklif_al":
        return this.teklifAl(input as In<typeof TeklifAlInputSchema>);
      case "izin_iste":
        return this.izinIste(input as In<typeof IzinIsteInputSchema>);
      case "emri_uygula":
        return this.emriUygula(input as In<typeof EmriUygulaInputSchema>);
      case "kullaniciya_sor":
        return this.kullaniciyaSor(input as In<typeof KullaniciyaSorInputSchema>);
      case "haberleri_oku":
        return this.haberleriOku();
      case "ekonomik_takvim":
        return this.ekonomikTakvim();
      case "bekle":
        return this.bekle(input as In<typeof BekleInputSchema>);
      case "bitir":
        return this.bitir(input as In<typeof BitirInputSchema>);
    }
  }

  // ─────────────────────────── okuma ───────────────────────────

  /** Plan bu PİLOT'un değilse (plan.agent ≠ PİLOT_AGENT) etkin sayılmaz: requestBuy zaten NotAgent ile döner. */
  private async planOku() {
    const nowSec = msToSec(this.deps.clock.nowMs());
    const [{ plan, active }, cycle] = await Promise.all([this.deps.chain.readPlan(), this.deps.chain.readCycle()]);
    const ours = plan !== null && isAddressEqual(plan.agent, this.deps.chain.agent);
    return { active: active && ours, plan, cycle, trDay: trDay(nowSec), cycleId: cycleIdOf(nowSec), nowSec };
  }

  /**
   * Karar tablosu girdisini kod kurar (LLM'den hiçbir alan gelmez): zincir planı + döngü, Lira Hava Durumu, soru
   * durumu, yarısı-alındı bölümü. Herhangi bir okuma başarısızsa tabloya geçersiz girdi verilir → yalnız bekleme.
   */
  private async advise(): Promise<Advice> {
    const nowMs = this.deps.clock.nowMs();
    let input: unknown = null;
    let weather: Weather | null = null;
    try {
      const [{ plan, active }, cycle, w] = await Promise.all([
        this.deps.chain.readPlan(),
        this.deps.chain.readCycle(),
        this.deps.weather.current(nowMs),
      ]);
      weather = w;
      if (plan !== null) {
        input = {
          nowSec: msToSec(nowMs),
          planActive: active && isAddressEqual(plan.agent, this.deps.chain.agent),
          plan,
          cycle,
          weather: w,
          question: this.state.pendingQuestion(),
          halfTakenEpisodeTs: this.state.halfTakenEpisodeTs,
        };
      }
    } catch {
      input = null;
    }
    return { out: kuralDanis(input), weather };
  }

  private async kuralDanis(): Promise<KuralDanisOutput> {
    this.advice = await this.advise();
    return this.advice.out;
  }

  private async teklifAl(i: In<typeof TeklifAlInputSchema>) {
    const id = buyOptionId(i.amountTL, i.ordType);
    // Önceki teklif bu çağrıyla geçersizleşir; yeni teklif doğrulanmadan izin_iste'ye ön koşul olmaz (kural 2).
    this.quotes.delete(id);
    const raw = await this.deps.kule.quote({ side: "buy", amountTL: i.amountTL, ordType: i.ordType });
    // KuleClient arayüzü doğrulamayı zorunlu kılmaz; teklif burada da şemadan geçmeden saklanmaz.
    const q = safeParseNoThrow(PILOT_TOOLS.teklif_al.output, raw);
    if (!q.success) throw new KuleError("kule_quote yanıtı doğrulanamadı", "kule_quote");
    this.quotes.set(id, q.data);
    return q.data;
  }

  // ─────────────────────────── izin ve emir ───────────────────────────

  private async izinIste(i: In<typeof IzinIsteInputSchema>): Promise<IzinOut> {
    const refused = (message: string): IzinOut => ({ status: "REFUSED", message });
    if (this.chainUncertain) return refused("Önceki izin isteğinin sonucu belirsiz; bu turda yeni izin istenmez.");
    if (this.authorized) return refused("Bu turda zaten bir izin alındı; turda en fazla bir izin.");
    if (!this.advice) return refused("Önce bu turda kural_danis çağrılmalı.");

    const id = buyOptionId(i.amountTL, i.ordType);
    if (!this.advice.out.allowed.includes(id)) {
      return refused(`Bu seçenek (${id}) bu turdaki kural_danis seçenekleri arasında yok: ${this.advice.out.allowed.join(", ")}.`);
    }
    const q = this.quotes.get(id);
    if (!q || q.verdict !== "ONAY" || !q.normalized) return refused("Önce bu tutar ve tür için teklif_al ONAY vermeli.");
    const quotePxE6 = pxToPxE6(q.normalized.px);
    const capE6 = Math.floor((quotePxE6 * (10_000 + MAX_PX_OVER_QUOTE_BPS)) / 10_000);
    if (i.maxPxE6 > capE6) {
      return refused(`maxPxE6 (${i.maxPxE6}) teklif fiyatının (${quotePxE6}) %${MAX_PX_OVER_QUOTE_BPS / 100}'den fazla üstünde.`);
    }

    // İzin anında tablo yeniden: tur içinde hava ya da döngü değiştiyse eski seçenekle izin istenmez.
    const fresh = await this.advise();
    this.advice = fresh;
    if (!fresh.out.allowed.includes(id)) {
      return refused(`Durum değişti; seçenek (${id}) artık izinli değil. Seçenekler: ${fresh.out.allowed.join(", ")}.`);
    }

    // TODO(spec): §8.1 reasonHash'in neyin özeti olduğunu yazmıyor; gerekçe metninin keccak256 özeti seçildi.
    const reasonHash = keccak256(stringToBytes(i.gerekce));
    let r;
    try {
      r = await this.deps.chain.requestBuy({ amountTL: i.amountTL, maxPxE6: i.maxPxE6, ordType: i.ordType, reasonHash });
    } catch (e) {
      if (!(e instanceof ChainError) || e.uncertain) this.chainUncertain = true;
      throw e;
    }
    if (r.status === "REJECTED") {
      return { status: "REJECTED", code: r.code, message: REJECT_TEXTS[r.code], tx: r.tx, finalityMs: r.finalityMs };
    }
    this.authorized = true;
    this.state.authorizations.set(r.actionId, {
      actionId: r.actionId,
      amountTL: i.amountTL,
      ordType: i.ordType,
      openBy: r.openBy,
      executed: false,
    });
    // §10.4: PRIM_SISMESI / BELIRSIZ bölümünde alınan yarıdan sonra kalan yarı fırtına bitince değerlendirilir.
    const ep = fresh.weather?.episode;
    if (ep && HALF_CLASSES.has(ep.type)) this.state.halfTakenEpisodeTs = ep.startTs;
    return { status: "AUTHORIZED", actionId: r.actionId, tx: r.tx, finalityMs: r.finalityMs };
  }

  private async emriUygula(i: In<typeof EmriUygulaInputSchema>) {
    const rec = this.state.authorizations.get(i.actionId);
    if (!rec) throw new ToolRefusal("Bu izin numarası PİLOT'un izin_iste sonucu değil; uygulanmaz.");
    if (rec.executed) throw new ToolRefusal("Bu izin zaten uygulandı.");
    const out = await this.deps.kule.execute({ actionId: i.actionId });
    if (out.verdict === "ONAY" || out.reasons.includes("ALREADY_EXECUTED")) rec.executed = true;
    return out;
  }

  // ─────────────────────────── soru ───────────────────────────

  private async kullaniciyaSor(i: In<typeof KullaniciyaSorInputSchema>) {
    if (!this.advice) throw new ToolRefusal("Önce bu turda kural_danis çağrılmalı.");
    if (!this.advice.out.allowed.includes("ASK")) throw new ToolRefusal("Karar tablosu şu an soru sormaya izin vermiyor.");
    const offer = this.advice.out.allowed.filter((o) => o !== "ASK");
    const bad = i.secenekler.filter((s) => !offer.includes(s));
    if (bad.length) throw new ToolRefusal(`Seçenekler bu turdaki izinli seçeneklerden olmalı (${offer.join(", ")}); geçersiz: ${bad.join(", ")}.`);
    const ep = this.advice.weather?.episode;
    if (!ep) throw new ToolRefusal("Fırtına bölümü yok; soru sorulmaz.");
    const q = this.state.ask({
      soru: i.soru,
      secenekler: [...i.secenekler],
      episodeStartTs: ep.startTs,
      askedAtSec: msToSec(this.deps.clock.nowMs()),
    });
    return { questionId: q.questionId, posted: true };
  }

  // ─────────────────────────── güvenilmeyen veri ───────────────────────────

  private async haberleriOku() {
    const r = await this.news.read(this.deps.clock.nowMs());
    const items = r.items.slice(0, NEWS_MAX_ITEMS).map((n) => ({
      id: clip(String(n.id), 64),
      ts: n.ts,
      title: clip(String(n.title), NEWS_MAX_TITLE),
      body: clip(String(n.body), NEWS_MAX_BODY),
      source: clip(String(n.source), 100),
    }));
    return { untrusted: true as const, demo: r.demo === true, items };
  }

  private async ekonomikTakvim() {
    const nowMs = this.deps.clock.nowMs();
    const r = await this.calendar.upcoming(nowMs);
    const events = r.events
      .filter((e) => Number.isSafeInteger(e.ts) && e.ts >= nowMs && e.ts <= nowMs + CALENDAR_HORIZON_MS)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, CALENDAR_MAX_EVENTS);
    return { demo: r.demo === true, events };
  }

  // ─────────────────────────── turu kapatan ───────────────────────────

  private async bekle(i: In<typeof BekleInputSchema>) {
    const untilMs = this.deps.clock.nowMs() + i.dakika * 60_000;
    this.ended = { tool: "bekle", untilMs, gerekce: i.gerekce };
    return { ok: true as const, untilMs };
  }

  /** TODO(spec): §10.2 bitir için koruma yazmıyor; en dar seçim: yalnız tablo BITIR'e izin verdiyse (ay erken kapanmasın). */
  private async bitir(i: In<typeof BitirInputSchema>) {
    if (!this.advice) throw new ToolRefusal("Önce bu turda kural_danis çağrılmalı.");
    if (!this.advice.out.allowed.includes("BITIR")) throw new ToolRefusal("Karar tablosu bu ayı bitirmeye izin vermiyor.");
    this.ended = { tool: "bitir", ozet: i.ozet };
    return { ok: true as const };
  }
}
