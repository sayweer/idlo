/**
 * Lira Hava Durumu hesaplayıcısı (SPEC §11) ve fırtına bölümü kuralı (§11.2). Saf fonksiyonlar; G/Ç yok.
 *
 * Zaman: OKX ms. `ts` her zaman bir 5 dk mumun KAPANIŞ anıdır (§11 "her 5 dakikalık mum kapanışında";
 * §15 örneği: ts 01:15 UTC, px = 01:10'da açılıp 01:15'te kapanan mumun kapanışı).
 * Hesaplayıcı yalnız tam zaman damgasıyla aranan, `ts`'de ya da önce kapanmış mumları okur; ileriye bakmaz.
 * Fail-closed: eksik / bozuk veri ya da şemaya uymayan sonuç WeatherError fırlatır; sınıf uydurulmaz.
 */
import {
  EPISODE_DURATION_MS,
  EpisodeSchema,
  WeatherSchema,
  ZD_ALARM,
  episodeDirOf,
  pxE6ToPx,
  pxToPxE6,
  parseOkxTs,
  secToMs,
  type Episode,
  type PxE6,
  type StormClass,
  type UnixMs,
  type Weather,
} from "@pilot/shared";

export class WeatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherError";
  }
}
function fail(message: string): never {
  throw new WeatherError(message);
}

export const MIN5_MS = secToMs(300);
export const HOUR_MS = secToMs(3600);

/** §11 eşikleri. */
export const BTC_CRASH_1H = -1.5; // btc1h ≤ −1,5 → KRIPTO_SISMESI
export const BTC_SHAKY_1H = -1.0; // −1,5 < btc1h ≤ −1,0 → BELIRSIZ
export const BTC_SHAKY_3H = -1.5; // btc3h ≤ −1,5 → BELIRSIZ
export const MED168_HOURS = 168;
/** §11 girdileri: USDT-TRY 5 dk son 13, USDT-TRY 1 sa son 169, BTC-USDT 5 dk son 37. */
export const LOOKBACK = { usdt5m: 13, usdt1h: 169, btc5m: 37 } as const;

/** Mum: `ts` AÇILIŞ zamanı (OKX ms); fiyatlar pxE6 (units.ts). */
export interface Candle {
  ts: UnixMs;
  o: PxE6;
  h: PxE6;
  l: PxE6;
  c: PxE6;
}

/** OKX satırı [ts, o, h, l, c, ...] → Candle (yalnız units.ts dönüşümleri). */
export function candleFromOkx(row: readonly string[]): Candle {
  if (!Array.isArray(row) || row.length < 5) fail(`mum satırı bozuk: ${JSON.stringify(row)}`);
  const c: Candle = {
    ts: parseOkxTs(row[0]!),
    o: pxToPxE6(row[1]!),
    h: pxToPxE6(row[2]!),
    l: pxToPxE6(row[3]!),
    c: pxToPxE6(row[4]!),
  };
  if (!ohlcOk(c)) fail(`mum OHLC tutarsız: ${row[0]}`);
  return c;
}

function ohlcOk(c: Candle): boolean {
  return c.l <= c.o && c.l <= c.c && c.o <= c.h && c.c <= c.h;
}

const isPositivePxE6 = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;

/**
 * MarketInput ön koşulu (fail-closed): ts kesin artan (tekrar / sırasızlık yok), fiyatlar pozitif güvenli tamsayı pxE6,
 * OHLC tutarlı. Canlı yol parseReplay'den geçmediği için her çağrıda tüm seri denetlenir.
 */
function assertSeries(candles: readonly Candle[], what: string): void {
  if (!Array.isArray(candles)) fail(`${what}: mum dizisi yok`);
  let prevTs = -1;
  for (const c of candles) {
    if (!Number.isSafeInteger(c.ts) || c.ts < 0) fail(`${what}: geçersiz mum ts: ${String(c.ts)}`);
    if (c.ts <= prevTs) fail(`${what}: mumlar kesin artan sırada değil (${new Date(c.ts).toISOString()} tekrar/sırasız)`);
    prevTs = c.ts;
    if (![c.o, c.h, c.l, c.c].every(isPositivePxE6) || !ohlcOk(c)) {
      fail(`${what}: bozuk mum (${new Date(c.ts).toISOString()})`);
    }
  }
}

const pxNum = (p: PxE6): number => Number(pxE6ToPx(p));

/** Artan sıralı mumlarda açılış zamanı tam `openTs` olanın indisi; yoksa −1. */
function indexOfOpen(candles: readonly Candle[], openTs: UnixMs): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = candles[mid]!.ts;
    if (t === openTs) return mid;
    if (t < openTs) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** `ts` anından k mum önce kapanan 5 dk mumun kapanışı (k = 0 → C_t). */
function close5mAt(candles: readonly Candle[], ts: UnixMs, k: number, what: string): PxE6 {
  const openTs = ts - (k + 1) * MIN5_MS;
  const i = indexOfOpen(candles, openTs);
  if (i < 0) fail(`${what}: ${new Date(openTs).toISOString()} açılışlı 5 dk mum yok (C_{t−${k}})`);
  return candles[i]!.c;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** med168 = medyan((H − L) / O × 10⁴), `ts` anında tamamlanmış son 168 saat (§11). */
export function med168Bp(usdt1h: readonly Candle[], ts: UnixMs): number {
  const lastOpen = Math.floor(ts / HOUR_MS) * HOUR_MS - HOUR_MS; // kapanışı ≤ ts olan son saat
  const end = indexOfOpen(usdt1h, lastOpen);
  if (end < 0) fail(`med168: ${new Date(lastOpen).toISOString()} açılışlı 1 sa mum yok`);
  const start = end - (MED168_HOURS - 1);
  if (start < 0) fail(`med168: ${MED168_HOURS} tamamlanmış saat yok`);
  const ranges: number[] = [];
  for (let i = start; i <= end; i++) {
    const c = usdt1h[i]!;
    if (c.ts !== lastOpen - (end - i) * HOUR_MS) fail(`med168: 1 sa mumlarda boşluk (${new Date(c.ts).toISOString()})`);
    ranges.push(((c.h - c.l) / c.o) * 1e4);
  }
  return median(ranges);
}

/**
 * fxOpen: Pazar 18:00 – Cuma 17:00, America/New_York (§11; Pyth EM FX takvimi).
 * Saat dilimi Intl ile çözülür (§11.2-3: yaz saati değişir; sabit UTC−4/−5 kullanılmaz).
 * TODO(spec): bayram / tatil günleri takvimi SPEC'te yok; yalnız haftalık takvim uygulanır.
 */
const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function nyClock(ts: UnixMs): { weekday: number; minutes: number } {
  const parts = NY.formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const weekday = WEEKDAYS.indexOf(get("weekday") ?? "");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (weekday < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)) fail(`New York saati çözülemedi: ${ts}`);
  return { weekday, minutes: hour * 60 + minute };
}

export function fxOpen(ts: UnixMs): boolean {
  const { weekday, minutes } = nyClock(ts);
  if (weekday === 6) return false; // cumartesi
  if (weekday === 0) return minutes >= 18 * 60; // pazar 18:00'den itibaren
  if (weekday === 5) return minutes < 17 * 60; // cuma 17:00'ye kadar
  return true;
}

export interface Metrics {
  ts: UnixMs;
  px: number; // C_t
  p12: number; // C_{t−12}: bölüm açılırsa P0
  r1hBp: number;
  med168Bp: number;
  zd: number;
  alarm: boolean;
  btc1h: number;
  btc3h: number;
  fxOpen: boolean;
}

export interface MarketInput {
  ts: UnixMs;
  usdt5m: readonly Candle[]; // artan sıralı, kapanmış
  usdt1h: readonly Candle[];
  btc5m: readonly Candle[];
}

/** §11 formülleri. */
export function computeMetrics(m: MarketInput): Metrics {
  const { ts } = m;
  if (!Number.isSafeInteger(ts) || ts < 0 || ts % MIN5_MS !== 0) fail(`ts 5 dk mum kapanışı olmalı: ${ts}`);
  assertSeries(m.usdt5m, "USDT-TRY 5m");
  assertSeries(m.usdt1h, "USDT-TRY 1H");
  assertSeries(m.btc5m, "BTC-USDT 5m");
  const ct = close5mAt(m.usdt5m, ts, 0, "USDT-TRY");
  const c12 = close5mAt(m.usdt5m, ts, 12, "USDT-TRY");
  const bt = close5mAt(m.btc5m, ts, 0, "BTC-USDT");
  const b12 = close5mAt(m.btc5m, ts, 12, "BTC-USDT");
  const b36 = close5mAt(m.btc5m, ts, 36, "BTC-USDT");
  const r1hBp = Math.log(ct / c12) * 1e4;
  const med = med168Bp(m.usdt1h, ts);
  const zd = Math.abs(r1hBp) / Math.max(1, med);
  return {
    ts,
    px: pxNum(ct),
    p12: pxNum(c12),
    r1hBp,
    med168Bp: med,
    zd,
    alarm: zd >= ZD_ALARM,
    btc1h: Math.log(bt / b12) * 100,
    btc3h: Math.log(bt / b36) * 100,
    fxOpen: fxOpen(ts),
  };
}

/** §11 tablosu: yalnız fırtınayı başlatan ilk alarm için (alarm mumunda çağrılır). */
export function classifyAlarm(m: Metrics): StormClass {
  if (!m.alarm) fail("classifyAlarm yalnız alarm mumunda çağrılır");
  if (m.r1hBp < 0) return "TL_GUCLENDI";
  if (m.btc1h <= BTC_CRASH_1H) return "KRIPTO_SISMESI";
  if (!m.fxOpen) return "PRIM_SISMESI";
  if (m.btc1h <= BTC_SHAKY_1H || m.btc3h <= BTC_SHAKY_3H) return "BELIRSIZ";
  return "LIRA_ZAYIFLADI";
}

function openEpisode(type: StormClass, m: Metrics): Episode {
  return {
    type,
    dir: episodeDirOf(type),
    P0: m.p12, // §11.2-1: alarm mumundan 12 mum önceki kapanış
    startTs: m.ts,
    lastAlarmTs: m.ts,
    endsAt: m.ts + EPISODE_DURATION_MS,
  };
}

/**
 * §11.2 bölüm kuralı: önceki bölüm + bu mumun ölçümleri → bu mumdaki bölüm (yoksa null).
 * - Bölüm `lastAlarmTs + 6 sa`'te kapanır; sürerken zd düşse de sınıf NORMAL'e dönmez.
 * - Her alarm mumu `lastAlarmTs`'i günceller.
 * - Yukarı bölüm: düşüş "şişme iniyor"dur; TL_GUCLENDI yalnız fiyat P0'ın altındayken geçerlidir ve yeni aşağı bölüm açar.
 *   TODO(spec): "TL_GUCLENDI geçerli olur" en dar biçimde okundu: alarm mumu + r1h < 0 (tablo TL_GUCLENDI der) + px < P0.
 *   Alarmsız bir P0 altı mum bölüm açmaz (§11.2-1: bölüm yalnız zd ≥ 8 mumunda açılır).
 * - Yükselme serbest: yukarı bölümde btc1h ≤ −1,5 olan her mumda sınıf KRIPTO_SISMESI olur; ters yönde düşüş yok.
 *   TODO(spec): yukarı sınıflar arasında başka geçiş (ör. BELIRSIZ → LIRA, LIRA → PRIM) tanımlı değil; yapılmaz.
 * - Aşağı bölüm (TL_GUCLENDI): yükseliş "toparlanıyor"dur; sınıf değişmez.
 *   TODO(spec): "Bölüm kuralı aynıdır" simetrik okundu: alarm mumu + r1h > 0 + px > P0 ise §11 tablosuyla yeni
 *   yukarı bölüm açılır (aksi hâlde P0'ın üstüne fırlamış bir fiyatta "şimdi çevir" sürerdi).
 */
export function stepEpisode(prev: Episode | null, m: Metrics): Episode | null {
  // Saklanmış bölüm güvenilmez (diskten okunur): bozuksa (ör. kısaltılmış endsAt) fırtına sessizce kapanmaz (§11.2).
  if (prev !== null && !EpisodeSchema.safeParse(prev).success) fail("saklanmış bölüm EpisodeSchema'ya uymuyor");
  if (prev !== null && m.ts < prev.lastAlarmTs) fail("zaman geri gidemez (ts < episode.lastAlarmTs)");
  const ep = prev !== null && m.ts < prev.endsAt ? prev : null;
  if (ep === null) return m.alarm ? openEpisode(classifyAlarm(m), m) : null;

  let type = ep.type;
  if (ep.dir === "up") {
    if (m.alarm && m.r1hBp < 0 && m.px < ep.P0) return openEpisode("TL_GUCLENDI", m);
    if (m.btc1h <= BTC_CRASH_1H) type = "KRIPTO_SISMESI";
  } else if (m.alarm && m.r1hBp > 0 && m.px > ep.P0) {
    return openEpisode(classifyAlarm(m), m);
  }
  const lastAlarmTs = m.alarm ? m.ts : ep.lastAlarmTs;
  return { ...ep, type, lastAlarmTs, endsAt: lastAlarmTs + EPISODE_DURATION_MS };
}

/** Bir mum kapanışında Weather (§15); sonuç paylaşılan zod şemasıyla doğrulanır (fail-closed). */
export function computeWeather(
  prev: Episode | null,
  market: MarketInput,
  src: Weather["src"],
): Weather {
  const m = computeMetrics(market);
  const episode = stepEpisode(prev, m);
  const out = {
    ts: m.ts,
    px: m.px,
    r1hBp: m.r1hBp,
    med168Bp: m.med168Bp,
    zd: m.zd,
    alarm: m.alarm,
    btc1h: m.btc1h,
    btc3h: m.btc3h,
    fxOpen: m.fxOpen,
    class: episode?.type ?? "NORMAL",
    stormUntil: episode?.endsAt ?? null,
    episode,
    src,
  };
  const r = WeatherSchema.safeParse(out);
  if (!r.success) fail(`Weather şemaya uymuyor: ${r.error.message}`);
  return r.data;
}
