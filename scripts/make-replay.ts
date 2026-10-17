/**
 * Kayıt oynatma dosyası üretici (SPEC §11.2 "Kayıt oynatma", §17.2 C2).
 *
 * OKX TR'nin herkese açık, ANAHTARSIZ `GET /api/v5/market/history-candles` uç noktasından
 * Lira Hava Durumu'nun (§11) girdilerini indirir ve `data/replays/<gün>.json` dosyalarına yazar.
 * Anahtar, imza ya da hesap çağrısı yoktur.
 *
 * Çalıştırma (repo kökünden):  pnpm exec tsx scripts/make-replay.ts [YYYY-MM-DD ...]
 * Argümansız çağrıda SPEC'teki beş gün indirilir.
 *
 * ── Dosya biçimi (format "pilot-replay/1") ──────────────────────────────────────────────
 * {
 *   "format": "pilot-replay/1",
 *   "day": "2024-08-05",              // UTC günü
 *   "source": "https://tr.okx.com/api/v5/market/history-candles",
 *   "fetchedAt": 1760000000000,       // OKX ms
 *   "simFrom": <ms>,                  // ilk karar anı (5 dk mum kapanışı) = gün 00:00 UTC − 48 sa (ısınma)
 *   "simTo":   <ms>,                  // son karar anı = gün+1 00:00 UTC + 12 sa
 *   "candles": {
 *     "USDT-TRY": { "5m": Row[], "1H": Row[] },
 *     "BTC-USDT": { "5m": Row[] }
 *   }
 * }
 * Row = [ts, o, h, l, c]: OKX'in ham string değerleri; ts = mumun AÇILIŞ zamanı (ms, string).
 * Satırlar artan ts sırasındadır; yalnız kapanmış (confirm = "1") mumlar yazılır.
 * Kapsam: 5 dk mumlar simFrom − 36 mum'dan (BTC 3 sa geriye bakış, §11) simTo'ya kadar;
 *         1 sa mumlar simFrom − 169 sa'ten (med168, §11) simTo'ya kadar.
 * Hesaplayıcı (apps/pilot/src/weather) her karar anında (mum kapanışı) yalnız o ana kadar kapanmış mumları kullanır.
 * Isınma (48 sa) sayesinde güne fırtına sürerken girilse bile bölüm durumu (§11.2) doğru kurulur.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Birim/zaman dönüşümleri yalnız units.ts'ten (CLAUDE.md kural 7). units.ts bağımlılıksızdır.
import { parseOkxTs, secToMs, trDateToSec, TR_UTC_OFFSET_SEC, type UnixMs } from "../packages/shared/units.js";

const BASE = "https://tr.okx.com"; // SPEC §9 / Ek B: OKX TR API tabanı
const PATH = "/api/v5/market/history-candles";
const DAYS = ["2024-08-05", "2025-03-19", "2025-10-10", "2025-12-02", "2026-02-01"];

const MIN5_MS = secToMs(300);
const HOUR_MS = secToMs(3600);
const DAY_MS = secToMs(86400);
const WARMUP_MS = 2 * DAY_MS; // bölüm durumunun ısınması
const TAIL_MS = 12 * HOUR_MS; // ertesi gün 12:00 UTC'ye kadar (bölüm kapanışı, W-8)
const LOOKBACK_5M = 36; // btc3h = ln(B_t / B_{t−36}) (§11)
const LOOKBACK_1H = 169; // son 169 saatlik mum (§11)
const PAGE_LIMIT = 100; // history-candles en fazla 100
const REQ_GAP_MS = 250; // herkese açık uç nokta sınırı (20 istek / 2 sn) altında kal
const MAX_RETRY = 5;

type Row = [string, string, string, string, string];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "YYYY-MM-DD" UTC gün başı → ms. TR 00:00 + 3 sa = UTC 00:00 (sabit UTC+3, units.ts). */
function utcDayStartMs(day: string): UnixMs {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`gün YYYY-MM-DD olmalı: ${day}`);
  return secToMs(trDateToSec(Number(m[1]), Number(m[2]), Number(m[3])) + TR_UTC_OFFSET_SEC);
}

let lastReq = 0;
async function getPage(instId: string, bar: string, after: UnixMs): Promise<string[][]> {
  const url = `${BASE}${PATH}?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${PAGE_LIMIT}&after=${after}`;
  for (let attempt = 1; ; attempt++) {
    const wait = lastReq + REQ_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const body = (await res.json()) as { code?: string; msg?: string; data?: string[][] };
      if (res.status === 429 || body.code === "50011") throw new Error(`hız sınırı (${res.status} ${body.code})`);
      if (!res.ok || body.code !== "0" || !Array.isArray(body.data)) {
        throw new Error(`OKX hatası: HTTP ${res.status} code=${body.code} msg=${body.msg}`);
      }
      return body.data;
    } catch (e) {
      if (attempt >= MAX_RETRY) throw e;
      await sleep(1000 * attempt);
    }
  }
}

/** [fromMs, toMs) aralığındaki kapanmış mumlar, artan sırada. Boşluk ya da onaysız mum varsa durur (fail-closed). */
async function fetchRange(instId: string, bar: "5m" | "1H", fromMs: UnixMs, toMs: UnixMs): Promise<Row[]> {
  const step = bar === "5m" ? MIN5_MS : HOUR_MS;
  const byTs = new Map<number, Row>();
  let after = toMs;
  while (after > fromMs) {
    const page = await getPage(instId, bar, after);
    if (page.length === 0) break;
    let oldest = after;
    for (const r of page) {
      const ts = parseOkxTs(r[0]!);
      oldest = Math.min(oldest, ts);
      if (ts < fromMs || ts >= toMs) continue;
      if (r[8] !== "1") throw new Error(`${instId} ${bar} ${r[0]}: kapanmamış mum`);
      byTs.set(ts, [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!]);
    }
    if (oldest >= after) break;
    after = oldest;
  }
  const rows = [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const expected = (toMs - fromMs) / step;
  const missing: number[] = [];
  for (let t = fromMs; t < toMs; t += step) if (!byTs.has(t)) missing.push(t);
  if (missing.length > 0) {
    throw new Error(
      `${instId} ${bar}: ${missing.length}/${expected} mum eksik (ilk: ${new Date(missing[0]!).toISOString()})`,
    );
  }
  return rows;
}

async function makeReplay(day: string, outDir: string) {
  const dayStart = utcDayStartMs(day);
  const simFrom = dayStart - WARMUP_MS;
  const simTo = dayStart + DAY_MS + TAIL_MS;
  // Karar anı ts = mum kapanışı; ts'de kapanan 5 dk mumun açılışı ts − 5 dk.
  const from5m = simFrom - MIN5_MS - LOOKBACK_5M * MIN5_MS;
  const from1h = simFrom - LOOKBACK_1H * HOUR_MS;
  const to = simTo; // [from, simTo) açılışlı mumlar ⇒ simTo'da kapanan mum dahil

  const usdt5m = await fetchRange("USDT-TRY", "5m", from5m, to);
  const usdt1h = await fetchRange("USDT-TRY", "1H", from1h, to);
  const btc5m = await fetchRange("BTC-USDT", "5m", from5m, to);

  const file = {
    format: "pilot-replay/1",
    day,
    source: `${BASE}${PATH}`,
    fetchedAt: Date.now(),
    simFrom,
    simTo,
    candles: {
      "USDT-TRY": { "5m": usdt5m, "1H": usdt1h },
      "BTC-USDT": { "5m": btc5m },
    },
  };
  const path = join(outDir, `${day}.json`);
  await writeFile(path, JSON.stringify(file) + "\n");
  console.log(
    `${path}: USDT-TRY 5m=${usdt5m.length}, USDT-TRY 1H=${usdt1h.length}, BTC-USDT 5m=${btc5m.length}`,
  );
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "data", "replays");
  await mkdir(outDir, { recursive: true });
  const days = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DAYS;
  for (const day of days) await makeReplay(day, outDir);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
