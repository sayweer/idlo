/**
 * M-1 (§14, §18): mutabakat.ts örnek veride EŞLEŞTİ, BORSADA VAR ZİNCİRDE YOK ve SONUÇ FARKLI durumlarını doğru basar;
 * anahtarı ağa yalnız OKX'e gönderir. Ayrıca §16 #18 (borsada izinsiz emir → ALARM) ve eşleştirme kenar durumları.
 * Ağ yok: OKX ve JSON-RPC taklit.
 */
import { describe, expect, it } from "vitest";
import { msToSec, secToMs, type ExecStatus, type OrdType } from "@pilot/shared";
import type { ChainAuthorized, ChainExecuted, ChainSnapshot } from "../lib/mutabakat-chain.js";
import {
  hasAlarm,
  MATCH_STATUS_TEXTS,
  OPEN_WINDOW_SEC,
  reconcile,
  REPORT_WINDOW_SEC,
  type MatchRow,
} from "../lib/mutabakat-match.js";
import { runMutabakat } from "../lib/mutabakat-run.js";
import type { OkxOrder } from "../lib/okx-readonly.js";
import { deploymentsText, ELIF, okxHandler, order, routerFetch, rpcHandler, type FakeLog } from "./helpers.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const NOW_SEC = msToSec(NOW.getTime());
const DAY = 86_400;
const WINDOW_START = NOW_SEC - 7 * DAY;

function auth(id: number, o: Partial<ChainAuthorized> = {}): ChainAuthorized {
  return {
    actionId: String(id),
    agentId: "17",
    amountTL: 150,
    maxPxE6: 41_000_000,
    ordType: "ioc",
    openBy: NOW_SEC - DAY + OPEN_WINDOW_SEC, // dün verilmiş
    tx: `0x${"ab".repeat(32)}`,
    ...o,
  };
}
function exec(id: number, o: Partial<ChainExecuted> = {}): ChainExecuted {
  return { actionId: String(id), ordId: `70${id}`, filledTL: 147, avgPxE6: 41_000_000, status: "FILLED", tx: `0x${"cd".repeat(32)}`, ...o };
}
/** İzin anından 1 dk sonra açılmış emir. */
function ord(id: number, a: ChainAuthorized, o: Partial<OkxOrder> = {}): OkxOrder {
  return order({ ordId: `70${id}`, clOrdId: `plt${id}`, cTime: String(secToMs(a.openBy - OPEN_WINDOW_SEC + 60)), ...o });
}
function snap(authorized: ChainAuthorized[], executed: ChainExecuted[] = [], nowSec = NOW_SEC): ChainSnapshot {
  return { authorized, executed, nowSec, head: 1000n };
}
function one(rows: MatchRow[]): MatchRow {
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("M-1 eşleştirme (§14 tablosu)", () => {
  it("M-1 EŞLEŞTİ: clOrdId plt<id>, ordId aynı, tutar ve fiyat %0,5 içinde (rapor kuruşu atar)", () => {
    const a = auth(1);
    // 3.66 × 40,95 = 149,877 TL; rapor 149 TL (tam lira).
    const r = one(reconcile({ snapshot: snap([a], [exec(1, { filledTL: 149, avgPxE6: 40_950_000 })]), orders: [ord(1, a, { accFillSz: "3.66", avgPx: "40.95" })], windowStartSec: WINDOW_START }));
    expect(r.status).toBe("MATCHED");
    expect(r.alarm).toBe(false);
    expect(r.actionId).toBe("1");
    expect(r.clOrdId).toBe("plt1");
    expect(r.exchange).toContain("149,87 TL");
  });

  it("M-1 / §16 #18 BORSADA VAR, ZİNCİRDE YOK → ALARM: clOrdId yok, PİLOT biçiminde değil, ya da izin Elif'in değil", () => {
    const rows = reconcile({
      snapshot: snap([]),
      orders: [
        order({ ordId: "801", cTime: String(NOW.getTime() - 3_600_000) }),
        order({ ordId: "802", clOrdId: "manual42", cTime: String(NOW.getTime() - 3_500_000) }),
        order({ ordId: "803", clOrdId: "plt99", cTime: String(NOW.getTime() - 3_400_000) }),
      ],
      windowStartSec: WINDOW_START,
    });
    expect(rows.map((r) => r.status)).toEqual(["EXCHANGE_ONLY", "EXCHANGE_ONLY", "EXCHANGE_ONLY"]);
    expect(rows.every((r) => r.alarm)).toBe(true);
    expect(rows[2]!.note).toContain("99");
    expect(hasAlarm(rows)).toBe(true);
  });

  it("M-1 SONUÇ FARKLI → ALARM: rapor tutarı, fiyatı ya da ordId'si borsadakiyle uyuşmuyor", () => {
    const a = auth(2);
    const o = ord(2, a, { accFillSz: "3.6", avgPx: "41" }); // 147,6 TL
    const amount = one(reconcile({ snapshot: snap([a], [exec(2, { filledTL: 100 })]), orders: [o], windowStartSec: WINDOW_START }));
    expect(amount.status).toBe("MISMATCH");
    expect(amount.note).toContain("tutar");
    const px = one(reconcile({ snapshot: snap([a], [exec(2, { avgPxE6: 40_700_000 })]), orders: [o], windowStartSec: WINDOW_START })); // %0,73
    expect(px.status).toBe("MISMATCH");
    expect(px.note).toContain("fiyat");
    const pxOk = one(reconcile({ snapshot: snap([a], [exec(2, { avgPxE6: 40_840_000 })]), orders: [o], windowStartSec: WINDOW_START })); // %0,39
    expect(pxOk.status).toBe("MATCHED");
    const id = one(reconcile({ snapshot: snap([a], [exec(2, { ordId: "999" })]), orders: [o], windowStartSec: WINDOW_START }));
    expect(id.status).toBe("MISMATCH");
    expect(id.note).toContain("ordId");
  });

  it("ZİNCİRDE VAR, BORSADA YOK (bilgi, ALARM değil): izin kullanılmadı; pencere öncesi izin gösterilmez", () => {
    const used = auth(3);
    const old = auth(4, { openBy: WINDOW_START - DAY });
    const rows = reconcile({ snapshot: snap([used, old]), orders: [], windowStartSec: WINDOW_START });
    const r = one(rows);
    expect(r.status).toBe("CHAIN_ONLY");
    expect(r.alarm).toBe(false);
    expect(r.note).toContain("süresi doldu");
    // Raporu iptal (dolumsuz) olan izin de bilgi.
    expect(one(reconcile({ snapshot: snap([used], [exec(3, { filledTL: 0, avgPxE6: 0, status: "CANCELED" })]), orders: [], windowStartSec: WINDOW_START })).status).toBe("CHAIN_ONLY");
  });

  it("rapor dolum gösteriyor ama borsada emir yok → ALARM SONUÇ FARKLI", () => {
    const a = auth(5);
    const r = one(reconcile({ snapshot: snap([a], [exec(5)]), orders: [], windowStartSec: WINDOW_START }));
    expect(r.status).toBe("MISMATCH");
  });

  it.each<[string, Partial<OkxOrder>, Partial<ChainAuthorized>]>([
    ["satış emri", { side: "sell" }, {}],
    ["emir türü izindekinden farklı", { ordType: "market" }, {}],
    ["post_only izni ioc emirle", {}, { ordType: "post_only" as OrdType }],
    ["emir fiyatı izindeki en yüksek fiyatın üstünde", { px: "41.5", avgPx: "41" }, {}],
    ["ortalama dolum fiyatı en yüksek fiyatın üstünde", { px: "", avgPx: "41.2" }, {}],
    ["dolum izin tutarını aşıyor", { sz: "10", accFillSz: "10", avgPx: "41" }, {}],
    ["emir izinden önce açılmış", { cTime: String(secToMs(NOW_SEC - 2 * DAY)) }, {}],
    ["dolum okunamıyor", { avgPx: "" }, {}],
  ])("emir izinle uyuşmuyor (%s) → ALARM SONUÇ FARKLI, rapor doğru olsa bile", (_n, oo, ao) => {
    const a = auth(6, ao);
    const r = one(reconcile({ snapshot: snap([a], [exec(6)]), orders: [ord(6, a, oo)], windowStartSec: WINDOW_START }));
    expect(r.status).toBe("MISMATCH");
    expect(r.note).toContain("izinle uyuşmuyor");
  });

  it("aynı izinle borsada iki emir → her ikisi ALARM", () => {
    const a = auth(7);
    const rows = reconcile({ snapshot: snap([a], [exec(7)]), orders: [ord(7, a), ord(7, a, { ordId: "7999" })], windowStartSec: WINDOW_START });
    expect(rows.map((r) => r.status)).toEqual(["MISMATCH", "MISMATCH"]);
  });

  it("rapor penceresi: açık emir/raporsuz emir pencere içinde RAPOR BEKLENİYOR (bilgi); pencere kapanınca ALARM", () => {
    const fresh = auth(8, { openBy: NOW_SEC + 5 * 60 }); // 10 dk önce verildi
    const live = ord(8, fresh, { state: "live", accFillSz: "0", avgPx: "" });
    expect(one(reconcile({ snapshot: snap([fresh]), orders: [live], windowStartSec: WINDOW_START })).status).toBe("PENDING");
    expect(one(reconcile({ snapshot: snap([fresh]), orders: [ord(8, fresh)], windowStartSec: WINDOW_START })).status).toBe("PENDING");
    expect(one(reconcile({ snapshot: snap([fresh], [exec(8)]), orders: [live], windowStartSec: WINDOW_START })).status).toBe("MISMATCH");

    const late = NOW_SEC + 5 * 60 + REPORT_WINDOW_SEC + 1;
    expect(one(reconcile({ snapshot: snap([fresh], [], late), orders: [live], windowStartSec: WINDOW_START })).status).toBe("MISMATCH");
    const filledNoReport = one(reconcile({ snapshot: snap([fresh], [], late), orders: [ord(8, fresh)], windowStartSec: WINDOW_START }));
    expect(filledNoReport.status).toBe("MISMATCH");
    expect(filledNoReport.note).toContain("rapor yok");
    const unfilled = ord(8, fresh, { state: "canceled", accFillSz: "0", avgPx: "" });
    expect(one(reconcile({ snapshot: snap([fresh], [], late), orders: [unfilled], windowStartSec: WINDOW_START })).status).toBe("MATCHED");
  });

  it("küçük demo tutarında 1 TL yuvarlama payı: 150 TL'de 0,9 TL fark EŞLEŞTİ, 2 TL fark SONUÇ FARKLI", () => {
    const a = auth(9);
    const o = ord(9, a, { accFillSz: "3.65", avgPx: "41" }); // 149,65 TL
    expect(one(reconcile({ snapshot: snap([a], [exec(9, { filledTL: 149 })]), orders: [o], windowStartSec: WINDOW_START })).status).toBe("MATCHED");
    expect(one(reconcile({ snapshot: snap([a], [exec(9, { filledTL: 147 })]), orders: [o], windowStartSec: WINDOW_START })).status).toBe("MISMATCH");
  });

  it("izin olayı olmayan rapor → ALARM", () => {
    expect(one(reconcile({ snapshot: snap([], [exec(12)]), orders: [], windowStartSec: WINDOW_START })).status).toBe("MISMATCH");
  });
});

// ─────────────────────────────── uçtan uca (taklit ağ) ───────────────────────────────

const CREDS = { apiKey: "elif-readonly-key-1", secret: "elif-readonly-secret-2", passphrase: "elif-pass-3" };
const RPC = "https://rpc.test.example/ext/bc/C/rpc";
const ENV = {
  OKX_READONLY_API_KEY: CREDS.apiKey,
  OKX_READONLY_SECRET: CREDS.secret,
  OKX_READONLY_PASSPHRASE: CREDS.passphrase,
  FUJI_RPC: RPC,
  USER: ELIF,
};

function authLog(block: number, id: number, openBy: number, amountTL = 150n, user = ELIF): FakeLog {
  return { block, event: "BuyAuthorized", args: { actionId: BigInt(id), user, agentId: 17n, amountTL, maxPxE6: 41_000_000n, ordType: 1, openBy: BigInt(openBy) } };
}
function execLog(block: number, id: number, o: { ordId: string; filledTL: bigint; avgPxE6: bigint; status: ExecStatus }, user = ELIF): FakeLog {
  const status = ["FILLED", "PARTIAL", "CANCELED", "EXPIRED"].indexOf(o.status);
  return { block, event: "BuyExecuted", args: { actionId: BigInt(id), user, ordId: o.ordId, filledTL: o.filledTL, avgPxE6: o.avgPxE6, status } };
}

function scenario() {
  const ob1 = NOW_SEC - 2 * DAY;
  const ob2 = NOW_SEC - DAY;
  const ob3 = NOW_SEC - 3 * DAY;
  const logs: FakeLog[] = [
    authLog(150, 1, ob1),
    execLog(160, 1, { ordId: "701", filledTL: 149n, avgPxE6: 40_950_000n, status: "FILLED" }),
    authLog(5000, 2, ob2),
    execLog(5010, 2, { ordId: "702", filledTL: 100n, avgPxE6: 41_000_000n, status: "FILLED" }),
    authLog(7000, 3, ob3),
    // Başka kullanıcının izni (AuthBinding): Elif'in taramasına girmez.
    authLog(7100, 4, ob2, 40_000n, "0x000000000000000000000000000000000000a77a"),
  ];
  const at = (ob: number) => String(secToMs(ob - OPEN_WINDOW_SEC + 60));
  const history = [
    order({ ordId: "701", clOrdId: "plt1", cTime: at(ob1), accFillSz: "3.66", avgPx: "40.95" }),
    order({ ordId: "702", clOrdId: "plt2", cTime: at(ob2), accFillSz: "3.6", avgPx: "41" }),
    order({ ordId: "777", clOrdId: "", cTime: at(ob2), accFillSz: "900", avgPx: "41", sz: "900", px: "41" }),
    order({ ordId: "704", clOrdId: "plt4", cTime: at(ob2), accFillSz: "900", avgPx: "41", sz: "900", px: "41" }),
  ];
  return { logs, history };
}

describe("M-1 mutabakat.ts uçtan uca (taklit OKX + taklit Fuji RPC)", () => {
  it("M-1 örnek veri: EŞLEŞTİ, SONUÇ FARKLI, BORSADA VAR ZİNCİRDE YOK ve ZİNCİRDE VAR BORSADA YOK basılır; ALARM → çıkış 1", async () => {
    const { logs, history } = scenario();
    const okx = okxHandler({ ...CREDS, history });
    const rpc = rpcHandler({ head: 9000, nowSec: NOW_SEC, logs });
    const net = routerFetch({ okx, rpcUrl: RPC, rpc });
    const lines: string[] = [];
    const code = await runMutabakat({ argv: ["--days", "7"], env: ENV, fetch: net.fetch, now: () => NOW, readText: () => deploymentsText(), out: (l) => lines.push(l), chunk: 2048n });
    const text = lines.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("Etiket: CANLI");
    for (const s of ["MATCHED", "MISMATCH", "EXCHANGE_ONLY", "CHAIN_ONLY"] as const) expect(text).toContain(MATCH_STATUS_TEXTS[s]);
    const row = (id: string) => lines.find((l) => l.split(" │ ")[1]?.trim() === id) ?? "";
    expect(row("1")).toMatch(/^EŞLEŞTİ/);
    expect(row("2")).toMatch(/^ALARM SONUÇ FARKLI/);
    expect(row("3")).toMatch(/^ZİNCİRDE VAR, BORSADA YOK/);
    const unbound = lines.filter((l) => l.startsWith("ALARM BORSADA VAR, ZİNCİRDE YOK"));
    expect(unbound).toHaveLength(2); // clOrdId'siz emir + yabancı plan izni plt4
    expect(text).toContain("Anahtarı hemen iptal et");
    expect(text).toContain("EŞLEŞTİ: 1 · ZİNCİRDE VAR, BORSADA YOK: 1 · BORSADA VAR, ZİNCİRDE YOK: 2 · SONUÇ FARKLI: 1");

    // Zincir taraması deployBlock'tan (100) son bloğa (9000) parça parça; her parça iki olay için.
    const ranges = rpc.getLogsRanges;
    expect(ranges[0]![0]).toBe(100);
    expect(Math.max(...ranges.map((r) => r[1]))).toBe(9000);
    expect(ranges.every(([f, t]) => t - f + 1 <= 2048)).toBe(true);
    expect(ranges.length).toBe(2 * Math.ceil((9000 - 100 + 1) / 2048));
  });

  it("M-1 anahtar ağa yalnız OKX'e gider: RPC isteklerinde anahtar/passphrase/imza yok; secret hiçbir istekte yok", async () => {
    const { logs, history } = scenario();
    const net = routerFetch({ okx: okxHandler({ ...CREDS, history }), rpcUrl: RPC, rpc: rpcHandler({ head: 9000, nowSec: NOW_SEC, logs }) });
    await runMutabakat({ argv: [], env: ENV, fetch: net.fetch, now: () => NOW, readText: () => deploymentsText(), out: () => undefined });
    expect(net.seen.some((s) => s.url.startsWith("https://tr.okx.com/"))).toBe(true);
    expect(net.seen.some((s) => s.url.startsWith(RPC))).toBe(true);
    for (const s of net.seen) {
      const all = s.url + JSON.stringify(s.headers) + s.body;
      expect(all).not.toContain(CREDS.secret);
      const carriesKey = all.includes(CREDS.apiKey) || all.includes(CREDS.passphrase) || "ok-access-sign" in s.headers;
      if (carriesKey) {
        expect(new URL(s.url).origin).toBe("https://tr.okx.com");
        expect(s.method).toBe("GET");
      }
    }
    // OKX'e yalnız izin listesindeki GET'ler gitti.
    const okxPaths = new Set(net.seen.filter((s) => s.url.startsWith("https://tr.okx.com/")).map((s) => new URL(s.url).pathname));
    expect([...okxPaths].sort()).toEqual(["/api/v5/account/config", "/api/v5/trade/orders-history", "/api/v5/trade/orders-pending"]);
  });

  it("M-1 tüm emirler eşleşince ALARM yok → çıkış 0", async () => {
    const ob1 = NOW_SEC - 2 * DAY;
    const logs = [authLog(150, 1, ob1), execLog(160, 1, { ordId: "701", filledTL: 149n, avgPxE6: 40_950_000n, status: "FILLED" })];
    const history = [order({ ordId: "701", clOrdId: "plt1", cTime: String(secToMs(ob1 - 600)), accFillSz: "3.66", avgPx: "40.95" })];
    const net = routerFetch({ okx: okxHandler({ ...CREDS, history }), rpcUrl: RPC, rpc: rpcHandler({ head: 300, nowSec: NOW_SEC, logs }) });
    const lines: string[] = [];
    expect(await runMutabakat({ argv: [], env: ENV, fetch: net.fetch, now: () => NOW, readText: () => deploymentsText(), out: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("ALARM yok");
  });

  it("M-1 --demo: OKX demo başlığı ve ekranda DEMO etiketi", async () => {
    const net = routerFetch({ okx: okxHandler(CREDS), rpcUrl: RPC, rpc: rpcHandler({ head: 300, nowSec: NOW_SEC, logs: [] }) });
    const lines: string[] = [];
    expect(await runMutabakat({ argv: ["--demo"], env: ENV, fetch: net.fetch, now: () => NOW, readText: () => deploymentsText(), out: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("Etiket: DEMO (OKX demo hesabı)");
    expect(net.seen.filter((s) => s.url.startsWith("https://tr.okx.com/")).every((s) => s.headers["x-simulated-trading"] === "1")).toBe(true);
  });

  it.each<[string, Record<string, string | undefined>, string[], Partial<Parameters<typeof okxHandler>[0]>, { chainId?: number }]>([
    ["trade yetkili anahtar", {}, [], { perm: "read_only,trade" }, {}],
    ["yanlış zincir", {}, [], {}, { chainId: 1 }],
    ["USER kabuk kullanıcı adı", { USER: "seyit" }, [], {}, {}],
    ["anahtar eksik", { OKX_READONLY_SECRET: undefined }, [], {}, {}],
    ["bilinmeyen argüman", {}, ["--withdraw"], {}, {}],
    ["gün aralığı dışı", {}, ["--days", "91"], {}, {}],
    ["OKX hata kodu", {}, [], { failCode: "50001" }, {}],
  ])("çalışamazsa (%s) çıkış 2; temiz sonuç basılmaz; secret mesajda yok", async (_n, envO, argv, okxO, rpcO) => {
    const net = routerFetch({ okx: okxHandler({ ...CREDS, ...okxO }), rpcUrl: RPC, rpc: rpcHandler({ head: 300, nowSec: NOW_SEC, logs: [], ...rpcO }) });
    const lines: string[] = [];
    const code = await runMutabakat({ argv, env: { ...ENV, ...envO }, fetch: net.fetch, now: () => NOW, readText: () => deploymentsText(), out: (l) => lines.push(l) });
    expect(code).toBe(2);
    const text = lines.join("\n");
    expect(text).not.toContain("ALARM yok");
    expect(text).not.toContain(CREDS.secret);
  });

  it("trade yetkili anahtarla emir listesi hiç istenmez (yetki denetimi önce)", async () => {
    const okx = okxHandler({ ...CREDS, perm: "read_only,trade" });
    const net = routerFetch({ okx, rpcUrl: RPC, rpc: rpcHandler({ head: 300, nowSec: NOW_SEC, logs: [] }) });
    await runMutabakat({ argv: [], env: ENV, fetch: net.fetch, now: () => NOW, readText: () => deploymentsText(), out: () => undefined });
    expect(okx.calls.map((c) => c.path)).toEqual(["/api/v5/account/config"]);
    expect(net.seen.some((s) => s.url.startsWith(RPC))).toBe(false);
  });
});
