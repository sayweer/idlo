/**
 * M-1 / §16 #18 saldırgan testleri (mutabakat). Ağ yok: OKX ve JSON-RPC taklit.
 * Konular: zincirde izni olmayan borsa emri (her biçimde ALARM), borsada emri olmayan izin, tutar/fiyat farkı,
 * aynı clOrdId, sayfalama boşlukları, saat/birim (ms ↔ sn, units.ts), salt-okunur anahtarın emir/çekim yoluna
 * hiçbir koşulda gidememesi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { msToSec, secToMs } from "@pilot/shared";
import type { ChainAuthorized, ChainExecuted, ChainSnapshot } from "../lib/mutabakat-chain.js";
import { CLOCK_SKEW_SEC, OPEN_WINDOW_SEC, reconcile, REPORT_WINDOW_SEC, type MatchRow } from "../lib/mutabakat-match.js";
import { runMutabakat } from "../lib/mutabakat-run.js";
import { OKX_MAX_PAGES, OKX_PAGE_LIMIT, OKX_READONLY_GET_PATHS, OkxReadonlyClient, type OkxOrder, type OkxReadonlyPath } from "../lib/okx-readonly.js";
import { deploymentsText, ELIF, HERE, okxHandler, order, routerFetch, rpcHandler, type FakeLog } from "./helpers.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const NOW_SEC = msToSec(NOW.getTime());
const DAY = 86_400;
const WINDOW_START = NOW_SEC - 7 * DAY;
const OTHER: Address = "0x0000000000000000000000000000000000000bad";
const CREDS = { apiKey: "elif-ro-key-0001", secret: "elif-ro-secret-0001", passphrase: "elif-ro-pass-0001" };
const RPC = "https://rpc.test/ext/bc/C/rpc";

// ─────────────────────────── saf eşleştirme yardımcıları ───────────────────────────

function auth(id: number, o: Partial<ChainAuthorized> = {}): ChainAuthorized {
  return {
    actionId: String(id),
    agentId: "17",
    amountTL: 150,
    maxPxE6: 41_000_000,
    ordType: "ioc",
    openBy: NOW_SEC - DAY + OPEN_WINDOW_SEC,
    tx: `0x${"ab".repeat(32)}`,
    ...o,
  };
}
function exec(id: number, o: Partial<ChainExecuted> = {}): ChainExecuted {
  return { actionId: String(id), ordId: `70${id}`, filledTL: 147, avgPxE6: 41_000_000, status: "FILLED", tx: `0x${"cd".repeat(32)}`, ...o };
}
function ord(id: number, a: ChainAuthorized, o: Partial<OkxOrder> = {}): OkxOrder {
  // 3.6 × 41 = 147,6 TL
  return order({ ordId: `70${id}`, clOrdId: `plt${id}`, cTime: String(secToMs(a.openBy - OPEN_WINDOW_SEC + 60)), ...o });
}
function snap(authorized: ChainAuthorized[], executed: ChainExecuted[] = [], nowSec = NOW_SEC): ChainSnapshot {
  return { authorized, executed, nowSec, head: 1000n };
}
function rec(authorized: ChainAuthorized[], executed: ChainExecuted[], orders: OkxOrder[], nowSec = NOW_SEC): MatchRow[] {
  return reconcile({ snapshot: snap(authorized, executed, nowSec), orders, windowStartSec: WINDOW_START });
}
function one(rows: MatchRow[]): MatchRow {
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

// ─────────────────────────── uçtan uca yardımcıları ───────────────────────────

function authLog(id: number, o: { user?: Address; amountTL?: bigint; openBy?: number; block?: number } = {}): FakeLog {
  return {
    block: o.block ?? 150,
    event: "BuyAuthorized",
    args: { actionId: BigInt(id), user: o.user ?? ELIF, agentId: 17n, amountTL: o.amountTL ?? 150n, maxPxE6: 41_000_000n, ordType: 1, openBy: BigInt(o.openBy ?? NOW_SEC - DAY + OPEN_WINDOW_SEC) },
  };
}
function execLog(id: number, o: { user?: Address; ordId?: string; filledTL?: bigint; block?: number } = {}): FakeLog {
  return {
    block: o.block ?? 160,
    event: "BuyExecuted",
    args: { actionId: BigInt(id), user: o.user ?? ELIF, ordId: o.ordId ?? `70${id}`, filledTL: o.filledTL ?? 147n, avgPxE6: 41_000_000n, status: 0 },
  };
}
const authAt = (openBy = NOW_SEC - DAY + OPEN_WINDOW_SEC) => String(secToMs(openBy - OPEN_WINDOW_SEC + 60));

interface E2E {
  okx?: Parameters<typeof okxHandler>[0] extends infer P ? Partial<P> : never;
  logs?: FakeLog[];
  argv?: string[];
  /** RPC isteğini taklide vermeden önce değiştir (ör. konu filtresini sil: kötü RPC). */
  rpcRewrite?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** OKX yanıtını değiştir (sayfalama hataları). */
  okxOverride?: (url: URL, init?: RequestInit) => Response | null;
  chunk?: bigint;
}

async function e2e(o: E2E = {}) {
  const okx = okxHandler({ ...CREDS, ...(o.okx ?? {}) });
  const rpc = rpcHandler({ head: 1000, nowSec: NOW_SEC, logs: o.logs ?? [] });
  const r = routerFetch({ okx, rpcUrl: RPC, rpc });
  const rpcMethods: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href.startsWith(RPC) && init?.body) {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown> | Record<string, unknown>[];
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) rpcMethods.push(String(m.method));
      if (o.rpcRewrite && !Array.isArray(parsed)) init = { ...init, body: JSON.stringify(o.rpcRewrite(parsed)) };
    }
    if (url.origin === "https://tr.okx.com" && o.okxOverride) {
      const res = o.okxOverride(url, init);
      if (res) return res;
    }
    return r.fetch(input, init);
  }) as typeof fetch;
  const lines: string[] = [];
  const code = await runMutabakat({
    argv: o.argv ?? ["--days", "7"],
    env: { OKX_READONLY_API_KEY: CREDS.apiKey, OKX_READONLY_SECRET: CREDS.secret, OKX_READONLY_PASSPHRASE: CREDS.passphrase, FUJI_RPC: RPC, USER: ELIF },
    fetch: f,
    now: () => NOW,
    readText: () => deploymentsText(),
    out: (l) => lines.push(l),
    chunk: o.chunk ?? 2048n,
  });
  return { code, lines, text: lines.join("\n"), seen: r.seen, okxCalls: okx.calls, rpcMethods, getLogsRanges: rpc.getLogsRanges };
}

const alarmRows = (lines: string[]) => lines.filter((l) => l.startsWith("ALARM "));

// ═══════════════════════════ 1. Zincirde izni olmayan borsa emri ═══════════════════════════

describe("M-1 / §16 #18 saldırgan: borsada var, zincirde yok → her biçimde ALARM", () => {
  it.each([
    ["baştaki sıfır (plt07)", "plt07"],
    ["büyük harf (PLT7)", "PLT7"],
    ["sonda boşluk", "plt7 "],
    ["ek (plt7x)", "plt7x"],
    ["Arapça-Hint rakamı (plt٧)", "plt٧"],
    ["sıfır numara (plt0)", "plt0"],
    ["negatif (plt-7)", "plt-7"],
    ["önek yok (7)", "7"],
  ])("M-1 izin 7 zincirde olsa bile clOrdId %s → EXCHANGE_ONLY ALARM (yalnız kanonik plt<id> bağlanır)", (_n, clOrdId) => {
    const a = auth(7);
    const rows = rec([a], [], [ord(7, a, { clOrdId, ordId: "9001" })]);
    const bad = rows.find((r) => r.ordId === "9001");
    expect(bad?.status).toBe("EXCHANGE_ONLY");
    expect(bad?.alarm).toBe(true);
  });

  it("M-1 başka kullanıcının izninin numarasını taşıyan emir (izin Elif'in değil) → ALARM; kötü RPC filtreyi yok saysa bile", async () => {
    // RPC konu filtresini (user) yok sayar ve OTHER'ın iznini de döndürür. Betik user'ı yeniden denetlemeli.
    const r = await e2e({
      logs: [authLog(5, { user: OTHER }), execLog(5, { user: OTHER })],
      okx: { history: [order({ ordId: "705", clOrdId: "plt5", cTime: authAt() })] },
      rpcRewrite: (b) => {
        if (b.method !== "eth_getLogs") return b;
        const [f] = b.params as [{ topics: unknown[] }];
        return { ...b, params: [{ ...f, topics: [f.topics[0]] }] };
      },
    });
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain("0 izin, 0 rapor");
    expect(alarmRows(r.lines)).toHaveLength(1);
    expect(alarmRows(r.lines)[0]).toMatch(/^ALARM BORSADA VAR, ZİNCİRDE YOK/);
    expect(r.text).toContain("Anahtarı hemen iptal et");
  });

  it("M-1 başka FlightPlan adresinden gelen izin olayı sayılmaz (kötü RPC adres filtresini yok sayar) → emir ALARM", async () => {
    const fake: FakeLog = { ...authLog(5), address: "0x9999999999999999999999999999999999999999" };
    const r = await e2e({
      logs: [fake],
      okx: { history: [order({ ordId: "705", clOrdId: "plt5", cTime: authAt() })] },
      rpcRewrite: (b) => {
        if (b.method !== "eth_getLogs") return b;
        const [f] = b.params as [Record<string, unknown>];
        return { ...b, params: [{ ...f, address: "0x9999999999999999999999999999999999999999" }] };
      },
    });
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain("0 izin, 0 rapor");
    expect(alarmRows(r.lines)[0]).toMatch(/^ALARM BORSADA VAR, ZİNCİRDE YOK/);
  });

  it("M-1 izinsiz emir yalnız açık emirlerde (orders-pending) → ALARM", async () => {
    const r = await e2e({ okx: { pending: [order({ ordId: "777", clOrdId: "", state: "live", accFillSz: "0", avgPx: "", cTime: String(NOW.getTime() - 60_000) })] } });
    expect(r.code, r.text).toBe(1);
    expect(alarmRows(r.lines)[0]).toMatch(/^ALARM BORSADA VAR, ZİNCİRDE YOK/);
  });

  it("M-1 izinsiz, dolmamış ve iptal edilmiş emir de ALARM (anahtar ele geçmiş demektir)", () => {
    const rows = rec([], [], [order({ ordId: "778", clOrdId: "x", state: "canceled", accFillSz: "0", avgPx: "", cTime: String(NOW.getTime() - 60_000) })]);
    expect(one(rows).status).toBe("EXCHANGE_ONLY");
    expect(one(rows).alarm).toBe(true);
  });

  it("M-1 izinli emirler arasına saklanmış tek izinsiz emir ALARM'ı tetikler (çıkış 1)", async () => {
    const logs = [authLog(1), execLog(1), authLog(2), execLog(2)];
    const r = await e2e({
      logs,
      okx: {
        history: [
          order({ ordId: "701", clOrdId: "plt1", cTime: authAt() }),
          order({ ordId: "999", clOrdId: "plt3", cTime: authAt() }),
          order({ ordId: "702", clOrdId: "plt2", cTime: authAt() }),
        ],
      },
    });
    expect(r.code, r.text).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("EŞLEŞTİ"))).toHaveLength(2);
    expect(alarmRows(r.lines)).toHaveLength(1);
    expect(r.text).not.toContain("ALARM yok");
  });

  it("M-1 izinli emirde yön satış ya da emir türü market → ALARM SONUÇ FARKLI", () => {
    const a = auth(1);
    for (const o of [{ side: "sell" }, { ordType: "market", px: "" }, { ordType: "limit" }]) {
      const r = one(rec([a], [exec(1)], [ord(1, a, o)]));
      expect(r.status, JSON.stringify(o)).toBe("MISMATCH");
      expect(r.alarm).toBe(true);
    }
  });
});

// ═══════════════════════════ 2. Borsada emri olmayan izin ═══════════════════════════

describe("M-1 saldırgan: zincirde var, borsada yok", () => {
  it("M-1 süresi dolmuş, raporsuz izin → ZİNCİRDE VAR, BORSADA YOK (bilgi); çıkış 0", async () => {
    const r = await e2e({ logs: [authLog(1)] });
    expect(r.code, r.text).toBe(0);
    expect(r.lines.some((l) => l.startsWith("ZİNCİRDE VAR, BORSADA YOK"))).toBe(true);
    expect(r.text).toContain("ALARM yok");
  });

  it("M-1 rapor 1 TL bile dolum gösteriyorsa ve borsada emir yoksa → ALARM SONUÇ FARKLI", () => {
    const a = auth(1);
    const r = one(rec([a], [exec(1, { filledTL: 1, status: "PARTIAL" })], []));
    expect(r.status).toBe("MISMATCH");
    expect(r.alarm).toBe(true);
  });

  it("M-1 rapor ordId'si clOrdId'siz bir emri gösteriyor → hem izin hem emir ALARM", () => {
    const a = auth(1);
    const rows = rec([a], [exec(1, { ordId: "555" })], [order({ ordId: "555", clOrdId: "", cTime: authAt() })]);
    expect(rows.map((x) => [x.status, x.alarm])).toEqual([
      ["MISMATCH", true],
      ["EXCHANGE_ONLY", true],
    ]);
  });

  it("M-1 pencere başı sınırı: tam pencere başında verilmiş izin gösterilir, 1 sn öncesi gösterilmez (sn birimi)", () => {
    const at = auth(1, { openBy: WINDOW_START + OPEN_WINDOW_SEC });
    const before = auth(2, { openBy: WINDOW_START - 1 + OPEN_WINDOW_SEC });
    const rows = rec([at, before], [], []);
    expect(rows.map((r) => r.actionId)).toEqual(["1"]);
  });
});

// ═══════════════════════════ 3. Tutar ve fiyat farkı ═══════════════════════════

describe("M-1 saldırgan: tutar / fiyat farkı", () => {
  const big = auth(1, { amountTL: 10_000 });
  // 243,9 × 41 = 9.999,9 TL
  const bigOrd = ord(1, big, { accFillSz: "243.9", sz: "243.9" });

  it("M-1 büyük emirde rapor dolumdan %0,6 az → ALARM; %0,4 az → EŞLEŞTİ", () => {
    expect(one(rec([big], [exec(1, { filledTL: 9_939 })], [bigOrd])).status).toBe("MISMATCH"); // %0,61
    expect(one(rec([big], [exec(1, { filledTL: 9_960 })], [bigOrd])).status).toBe("MATCHED"); // %0,40
  });

  it("M-1 rapor 0 TL, borsada 147 TL dolum → ALARM", () => {
    const a = auth(1);
    const r = one(rec([a], [exec(1, { filledTL: 0, avgPxE6: 0, status: "CANCELED" })], [ord(1, a)]));
    expect(r.status).toBe("MISMATCH");
  });

  it("M-1 rapor fiyatı %0,6 farklı → ALARM; %0,4 farklı → EŞLEŞTİ", () => {
    const a = auth(1, { maxPxE6: 42_000_000 });
    expect(one(rec([a], [exec(1, { avgPxE6: 40_754_000 })], [ord(1, a)])).status).toBe("MISMATCH");
    expect(one(rec([a], [exec(1, { avgPxE6: 40_836_000 })], [ord(1, a)])).status).toBe("MATCHED");
  });

  it("M-1 borsa dolumu izin tutarını aşıyor (rapor da aynıysa bile) → ALARM", () => {
    const a = auth(1);
    // 4.0 × 41 = 164 TL > 150 TL izin
    const r = one(rec([a], [exec(1, { filledTL: 150 })], [ord(1, a, { accFillSz: "4", sz: "4" })]));
    expect(r.status).toBe("MISMATCH");
    expect(r.note).toContain("dolum");
  });

  it("M-1 dolum fiyatı izindeki en yüksek fiyatın üstünde → ALARM", () => {
    const a = auth(1);
    const r = one(rec([a], [exec(1, { avgPxE6: 41_100_000 })], [ord(1, a, { avgPx: "41.1", px: "41" })]));
    expect(r.status).toBe("MISMATCH");
  });

  it("M-1 dolum var ama avgPx boş (okunamıyor) → ALARM, EŞLEŞTİ değil", () => {
    const a = auth(1);
    const r = one(rec([a], [exec(1)], [ord(1, a, { avgPx: "" })]));
    expect(r.status).toBe("MISMATCH");
  });

  it("M-1 rapor penceresi kapanınca raporsuz dolum ALARM; tam reportBy anında RAPOR BEKLENİYOR (sn birimi)", () => {
    const a = auth(1, { openBy: NOW_SEC - REPORT_WINDOW_SEC });
    expect(one(rec([a], [], [ord(1, a)], a.openBy + REPORT_WINDOW_SEC)).status).toBe("PENDING");
    expect(one(rec([a], [], [ord(1, a)], a.openBy + REPORT_WINDOW_SEC + 1)).status).toBe("MISMATCH");
  });
});

// ═══════════════════════════ 4. Aynı clOrdId ═══════════════════════════

describe("M-1 saldırgan: aynı clOrdId", () => {
  it("M-1 aynı clOrdId biri açık (pending) biri geçmişte, farklı ordId → ikisi de ALARM (uçtan uca)", async () => {
    const r = await e2e({
      logs: [authLog(1), execLog(1)],
      okx: {
        pending: [order({ ordId: "800", clOrdId: "plt1", state: "live", accFillSz: "0", avgPx: "", cTime: authAt() })],
        history: [order({ ordId: "701", clOrdId: "plt1", cTime: authAt() })],
      },
    });
    expect(r.code, r.text).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("ALARM SONUÇ FARKLI"))).toHaveLength(2);
    expect(r.text).not.toMatch(/^EŞLEŞTİ/m);
  });

  it("M-1 aynı izin numarasına üç emir (biri dolmamış) → üçü de ALARM, hiçbiri EŞLEŞTİ değil", () => {
    const a = auth(1);
    const rows = rec([a], [exec(1)], [ord(1, a), ord(1, a, { ordId: "7011", accFillSz: "0", avgPx: "", state: "canceled" }), ord(1, a, { ordId: "7012" })]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "MISMATCH" && r.alarm)).toBe(true);
  });

  it("M-1 aynı ordId hem açık hem geçmiş listesinde → tek emir sayılır (yinelenmiş sayılıp yanlış ALARM ya da çift dolum yok)", async () => {
    const o = order({ ordId: "701", clOrdId: "plt1", cTime: authAt() });
    const r = await e2e({ logs: [authLog(1), execLog(1)], okx: { pending: [o], history: [o] } });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("1 emir");
  });
});

// ═══════════════════════════ 5. Sayfalama ve okuma boşlukları ═══════════════════════════

describe("M-1 saldırgan: sayfalama ve eksik veri (fail-closed)", () => {
  /** Tamamı Elif'in izinlerine bağlı n emir + belirtilen sırada bir izinsiz emir. */
  function bulk(n: number, intruderAt: number) {
    const logs: FakeLog[] = [];
    const rows: OkxOrder[] = [];
    for (let i = 1; i <= n; i++) {
      logs.push(authLog(i), execLog(i, { ordId: String(100_000 + i) }));
      rows.push(order({ ordId: String(100_000 + i), clOrdId: `plt${i}`, cTime: authAt() }));
    }
    rows.splice(intruderAt, 0, order({ ordId: "999999", clOrdId: "", cTime: authAt() }));
    return { logs, rows };
  }

  it("M-1 izinsiz emir 2. sayfada (tam 100'lük ilk sayfadan sonra) → bulunur, ALARM", async () => {
    const { logs, rows } = bulk(OKX_PAGE_LIMIT + 20, OKX_PAGE_LIMIT + 5);
    const r = await e2e({ logs, okx: { history: rows } });
    expect(r.code, r.text.slice(-500)).toBe(1);
    expect(alarmRows(r.lines)).toHaveLength(1);
    const hist = r.okxCalls.filter((c) => c.path === "/api/v5/trade/orders-history");
    expect(hist).toHaveLength(2);
    expect(hist[1]!.query.after).toBe(rows[OKX_PAGE_LIMIT - 1]!.ordId);
  });

  it("M-1 tam 100 emirlik tek sayfa: ikinci (boş) sayfa da istenir; izinsiz emir son sırada olsa bile bulunur", async () => {
    const { logs, rows } = bulk(OKX_PAGE_LIMIT - 1, OKX_PAGE_LIMIT - 1);
    expect(rows).toHaveLength(OKX_PAGE_LIMIT);
    const r = await e2e({ logs, okx: { history: rows } });
    expect(r.code).toBe(1);
    expect(r.okxCalls.filter((c) => c.path === "/api/v5/trade/orders-history")).toHaveLength(2);
  });

  it("M-1 OKX `after` imlecini yok sayıp hep aynı sayfayı dönerse sonsuz döngü ya da sessiz eksik sonuç yok → çıkış 2", async () => {
    const same = Array.from({ length: OKX_PAGE_LIMIT }, (_, i) => order({ ordId: String(500 + i), clOrdId: "", cTime: authAt() }));
    const r = await e2e({
      okxOverride: (url) => (url.pathname === "/api/v5/trade/orders-history" ? Response.json({ code: "0", msg: "", data: same }) : null),
    });
    expect(r.code).toBe(2);
    expect(r.text).toContain("bu temiz sonuç sayılmaz");
    expect(r.text).not.toContain("ALARM yok");
  });

  it(`M-1 ${OKX_MAX_PAGES} sayfayı aşan emir geçmişi → çıkış 2 (kesilmiş liste "temiz" sayılmaz)`, async () => {
    let n = 0;
    const r = await e2e({
      okxOverride: (url) => {
        if (url.pathname !== "/api/v5/trade/orders-history") return null;
        const data = Array.from({ length: OKX_PAGE_LIMIT }, () => order({ ordId: String(++n), clOrdId: "", cTime: authAt() }));
        return Response.json({ code: "0", msg: "", data });
      },
    });
    expect(r.code).toBe(2);
    expect(r.text).not.toContain("ALARM yok");
  });

  it("M-1 2. sayfa HTTP 500 → çıkış 2; ilk sayfadaki temiz emirlere dayanıp 'ALARM yok' denmez", async () => {
    const { logs, rows } = bulk(OKX_PAGE_LIMIT + 5, 0);
    const r = await e2e({
      logs,
      okx: { history: rows },
      okxOverride: (url) => (url.searchParams.has("after") ? new Response("hata", { status: 500 }) : null),
    });
    expect(r.code).toBe(2);
    expect(r.text).not.toContain("ALARM yok");
  });

  it("M-1 biçimsiz emir satırı (clOrdId alanı yok / ordId sayı değil) atlanmaz → çıkış 2", async () => {
    for (const bad of [
      (() => {
        const { clOrdId: _c, ...rest } = order({ ordId: "1", cTime: authAt() });
        return rest;
      })(),
      { ...order({ ordId: "1", cTime: authAt() }), ordId: "1e3" },
      { ...order({ ordId: "1", cTime: authAt() }), accFillSz: "-1" },
      { ...order({ ordId: "1", cTime: authAt() }), cTime: "1.7e12" },
    ]) {
      const r = await e2e({ okx: { history: [bad as OkxOrder] } });
      expect(r.code, JSON.stringify(bad)).toBe(2);
    }
  });

  it("M-1 başka enstrümanın satırı (ör. BTC-TRY) sessizce atlanmaz → çıkış 2", async () => {
    const r = await e2e({ okx: { history: [order({ ordId: "1", instId: "BTC-TRY", cTime: authAt() })] } });
    expect(r.code).toBe(2);
  });

  it("M-1 eth_getLogs parçaları deployBlock'tan son bloğa boşluksuz ve çakışmasız (parça 7, son blok parça katı değil)", async () => {
    const r = await e2e({ chunk: 7n });
    const ranges = r.getLogsRanges.filter((_, i) => i % 2 === 0); // her parça için iki istek (izin + rapor)
    const uniq = [...new Map(r.getLogsRanges.map((x) => [x.join("-"), x])).values()].sort((a, b) => a[0] - b[0]);
    expect(uniq[0]![0]).toBe(100);
    expect(uniq.at(-1)![1]).toBe(1000);
    for (let i = 1; i < uniq.length; i++) expect(uniq[i]![0]).toBe(uniq[i - 1]![1] + 1);
    expect(ranges.length).toBeGreaterThan(0);
  });

  it("M-1 parça sınırındaki izin (deployBlock ve son blok) okunur", async () => {
    const r = await e2e({
      chunk: 7n,
      logs: [authLog(1, { block: 100 }), execLog(1, { block: 1000 })],
      okx: { history: [order({ ordId: "701", clOrdId: "plt1", cTime: authAt() })] },
    });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("1 izin, 1 rapor");
  });

  it("M-1 RPC bir parçada hata verirse çıkış 2 (olay eksikse her emir izinsiz ya da her izin boş görünürdü)", async () => {
    let n = 0;
    const r = await e2e({
      chunk: 100n,
      rpcRewrite: (b) => (b.method === "eth_getLogs" && ++n === 5 ? { ...b, method: "eth_bozuk" } : b),
    });
    expect(r.code).toBe(2);
    expect(r.text).not.toContain("ALARM yok");
  });
});

// ═══════════════════════════ 6. Saat ve birim (ms ↔ sn, UTC) ═══════════════════════════

describe("M-1 saldırgan: saat ve birimler (units.ts)", () => {
  const a = auth(1);
  const authorizedAtMs = secToMs(a.openBy - OPEN_WINDOW_SEC);

  it("M-1 kayma payı sınırı (ms): izinden 60 sn önce açılan emir kabul, 60 sn + 1 ms önce açılan ALARM", () => {
    const at = (ms: number) => one(rec([a], [exec(1)], [ord(1, a, { cTime: String(ms) })])).status;
    expect(at(authorizedAtMs - secToMs(CLOCK_SKEW_SEC))).toBe("MATCHED");
    expect(at(authorizedAtMs - secToMs(CLOCK_SKEW_SEC) - 1)).toBe("MISMATCH");
  });

  it("M-1 openBy sınırı (ms): openBy + 60 sn'de açılan emir kabul, + 1 ms sonra ALARM", () => {
    const at = (ms: number) => one(rec([a], [exec(1)], [ord(1, a, { cTime: String(ms) })])).status;
    expect(at(secToMs(a.openBy + CLOCK_SKEW_SEC))).toBe("MATCHED");
    expect(at(secToMs(a.openBy + CLOCK_SKEW_SEC) + 1)).toBe("MISMATCH");
  });

  it("M-1 emir zamanı yanlışlıkla saniye (10 hane) → ms sanılıp izne uymuş sayılmaz → ALARM", () => {
    const r = one(rec([a], [exec(1)], [ord(1, a, { cTime: String(a.openBy - OPEN_WINDOW_SEC + 60) })]));
    expect(r.status).toBe("MISMATCH");
  });

  it("M-1 OKX sorgusu ms (13 hane): begin = şimdi − 7 gün, end = şimdi; zincir penceresi aynı anın saniyesi", async () => {
    const r = await e2e();
    const h = r.okxCalls.find((c) => c.path === "/api/v5/trade/orders-history")!;
    expect(h.query.begin).toBe(String(NOW.getTime() - 7 * DAY * 1000));
    expect(h.query.end).toBe(String(NOW.getTime()));
    expect(h.query.begin).toMatch(/^\d{13}$/);
  });

  it("M-1 OKX imza zaman damgası ISO-8601 UTC ('Z'), yerel saat dilimi (UTC+3) değil", async () => {
    const r = await e2e();
    const ts = r.seen.filter((s) => s.url.startsWith("https://tr.okx.com")).map((s) => s.headers["ok-access-timestamp"]);
    expect(ts.length).toBeGreaterThan(0);
    for (const t of ts) expect(t).toBe(NOW.toISOString());
  });

  it("M-1 --days 8 arşivden okur ve begin 8 gün öncesi; açık emirler yine okunur", async () => {
    const r = await e2e({ argv: ["--days", "8"] });
    const paths = r.okxCalls.map((c) => c.path);
    expect(paths).toContain("/api/v5/trade/orders-pending");
    expect(paths).toContain("/api/v5/trade/orders-history-archive");
    expect(paths).not.toContain("/api/v5/trade/orders-history");
    expect(r.okxCalls.find((c) => c.path.endsWith("archive"))!.query.begin).toBe(String(NOW.getTime() - 8 * DAY * 1000));
  });

  it.each([["0"], ["91"], ["7.5"], ["-1"], ["1e1"], [""]])("M-1 --days %s → çıkış 2, ağa istek yok", async (d) => {
    const r = await e2e({ argv: ["--days", d] });
    expect(r.code).toBe(2);
    expect(r.seen).toHaveLength(0);
  });
});

// ═══════════════════════════ 7. Salt-okunur anahtar: emir/çekim yolu imkânsız ═══════════════════════════

describe("M-1 saldırgan: salt-okunur anahtar emir, iptal ya da çekim yoluna gidemez", () => {
  function client() {
    const seen: { url: string; init?: RequestInit }[] = [];
    const okx = okxHandler({ ...CREDS });
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url: url.href, ...(init ? { init } : {}) });
      return okx.handle(url, init);
    }) as typeof fetch;
    return { c: new OkxReadonlyClient(CREDS, { fetch: f, now: () => NOW }), seen };
  }

  it.each([
    "/api/v5/trade/order",
    "/api/v5/trade/batch-orders",
    "/api/v5/trade/cancel-order",
    "/api/v5/trade/cancel-batch-orders",
    "/api/v5/trade/amend-order",
    "/api/v5/trade/cancel-all-after",
    "/api/v5/asset/withdrawal",
    "/api/v5/asset/transfer",
    "/api/v5/account/set-leverage",
    "/api/v5/trade/orders-pending/../order",
    "/api/v5/trade/orders-pending/",
    "/API/V5/ACCOUNT/CONFIG",
    "/api/v5/account/config?x=1",
    "//evil.example/api/v5/account/config",
    "https://evil.example/api/v5/account/config",
    "/api/v5/account/config#frag",
    "api/v5/account/config",
  ])("M-1 izin listesi dışı yol %s → hata, ağa hiç istek gitmez", async (p) => {
    const { c, seen } = client();
    await expect(c.get(p as OkxReadonlyPath)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it.each<[string, Record<string, string>]>([
    ["& ile sorgu ekleme", { instId: "USDT-TRY&ordType=market" }],
    ["yol ekleme", { after: "../../asset/withdrawal" }],
    ["# ile kesme", { instId: "USDT-TRY#" }],
    ["boşluk", { instId: "USDT TRY" }],
    ["izinsiz alan sz", { sz: "1" }],
    ["izinsiz alan side", { side: "buy" }],
    ["izinsiz alan ordType", { ordType: "market" }],
    ["boş değer", { instId: "" }],
  ])("M-1 sorgu enjeksiyonu (%s) → hata, ağa istek yok", async (_n, q) => {
    const { c, seen } = client();
    await expect(c.get("/api/v5/trade/orders-pending", q)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("M-1 istemcinin yazma yöntemi yok: prototipte yalnız get / assertReadOnly / listOrders / paginate", () => {
    expect(Object.getOwnPropertyNames(OkxReadonlyClient.prototype).sort()).toEqual(["assertReadOnly", "constructor", "get", "listOrders", "paginate"]);
    expect(OKX_READONLY_GET_PATHS.every((p) => /^\/api\/v5\/(account\/config|trade\/orders-(pending|history|history-archive))$/.test(p))).toBe(true);
  });

  it("M-1 kaynak taraması: mutabakat dosyalarında POST/PUT/DELETE, emir/iptal/çekim yolu ya da zincire işlem gönderen çağrı yok", () => {
    const files = ["../mutabakat.ts", "../lib/mutabakat-run.ts", "../lib/mutabakat-match.ts", "../lib/mutabakat-chain.ts", "../lib/okx-readonly.ts"];
    for (const f of files) {
      const src = readFileSync(join(HERE, f), "utf8");
      // Yorumlar hariç kod.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/["'`](POST|PUT|DELETE|PATCH)["'`]/);
      expect(code, f).not.toMatch(/\/api\/v5\/(asset|trade\/(order(?!s-)|batch|cancel|amend))/);
      expect(code, f).not.toMatch(/sendTransaction|sendRawTransaction|writeContract|createWalletClient|privateKeyToAccount/);
      for (const m of code.matchAll(/["'`](\/api\/v5\/[^"'`?]*)/g)) expect(OKX_READONLY_GET_PATHS as readonly string[], f).toContain(m[1]);
    }
  });

  it.each([
    ["read_only,trade"],
    ["trade"],
    ["read_only, withdraw"],
    ["withdraw,read_only"],
    ["READ_ONLY"],
    ["read_only,futures"],
    [""],
    [" , "],
  ])("M-1 anahtar yetkisi '%s' → çıkış 2, emir listesi hiç istenmez", async (perm) => {
    const r = await e2e({ okx: { perm } });
    expect(r.code).toBe(2);
    expect(r.okxCalls.map((c) => c.path)).toEqual(["/api/v5/account/config"]);
    expect(r.rpcMethods).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ["perm alanı yok", [{ uid: "1" }]],
    ["perm dizi", [{ perm: ["read_only"] }]],
    ["iki satır (biri trade)", [{ perm: "read_only" }, { perm: "trade" }]],
    ["boş data", []],
  ])("M-1 account/config biçimsiz (%s) → çıkış 2 (yetki doğrulanamazsa çalışmaz)", async (_n, data) => {
    const r = await e2e({
      okxOverride: (url) => (url.pathname === "/api/v5/account/config" ? Response.json({ code: "0", msg: "", data }) : null),
    });
    expect(r.code).toBe(2);
    expect(r.seen.filter((s) => s.url.includes("/trade/"))).toHaveLength(0);
  });

  it("M-1 tam çalıştırmada: OKX'e yalnız gövdesiz GET ve yalnız izinli yollar, yönlendirme kapalı; RPC'de yalnız okuma yöntemleri", async () => {
    const r = await e2e({ logs: [authLog(1), execLog(1)], okx: { history: [order({ ordId: "701", clOrdId: "plt1", cTime: authAt() })] } });
    expect(r.code, r.text).toBe(0);
    const okxReqs = r.seen.filter((s) => s.url.startsWith("https://tr.okx.com"));
    expect(okxReqs.length).toBeGreaterThanOrEqual(3);
    for (const s of okxReqs) {
      expect(s.method).toBe("GET");
      expect(s.body).toBe("");
      expect(OKX_READONLY_GET_PATHS as readonly string[]).toContain(new URL(s.url).pathname);
    }
    const allowed = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_blockNumber", "eth_getLogs"]);
    for (const m of r.rpcMethods) expect(allowed, m).toContain(m);
  });

  it("M-1 OKX yönlendirme izlenmez: fetch'e redirect:'error' verilir", async () => {
    const inits: RequestInit[] = [];
    const okx = okxHandler({ ...CREDS });
    const f = (async (input: string | URL | Request, init?: RequestInit) => (inits.push(init ?? {}), okx.handle(new URL(String(input)), init))) as typeof fetch;
    await new OkxReadonlyClient(CREDS, { fetch: f, now: () => NOW }).assertReadOnly();
    expect(inits.every((i) => i.redirect === "error")).toBe(true);
  });

  it("M-1 OKX 3xx yanıtı (yönlendirme izlenmeden) hata → çıkış 2", async () => {
    const r = await e2e({ okxOverride: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
    expect(r.code).toBe(2);
  });
});
