import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { limitBuySz, notionalTLE6, pxToPxE6 } from "@pilot/shared";
import { CaaLoop } from "../src/caa.js";
import { AGENT2, DEMO, FOREIGN_KULE, FOREIGN_USER, OTHER, PILOT, T0, USER, makeHarness, type Harness } from "./helpers.js";

const hs: Harness[] = [];
function setup(o: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(o);
  hs.push(h);
  return h;
}
afterEach(() => {
  while (hs.length) hs.pop()!.cleanup();
});

const diskRecord = (h: Harness, id: string) => (JSON.parse(readFileSync(h.actionsPath, "utf8")) as { actions: Record<string, { state: string }> }).actions[id];

describe("kule_execute: mutlu yol ve kontrol sırası (§9.2)", () => {
  it("U-14 post_only: fiyat tickSz'ye aşağı yuvarlanır, sz × px ≤ amountTL, clOrdId plt+actionId, emirden önce PLACED diske yazılır", async () => {
    const h = setup();
    h.exchange.bid = "49.500";
    h.exchange.ask = "49.510";
    h.chain.seed("7", { maxPxE6: 49_447_800 }); // 49,4478 → tick 0,001 → 49,447
    let onDiskAtPlace: string | undefined;
    const orig = h.exchange.placeOrder.bind(h.exchange);
    h.exchange.placeOrder = async (a) => {
      onDiskAtPlace = diskRecord(h, "7")?.state;
      return orig(a);
    };
    const r = await h.executor.execute(PILOT, "7");
    expect(r.verdict).toBe("ONAY");
    expect(r.status).toBe("FILLED");
    expect(r.clOrdId).toBe("plt7");
    expect(r.paper).toBe(false);
    expect(h.exchange.placed).toHaveLength(1);
    const o = h.exchange.placed[0]!;
    expect(o).toMatchObject({ instId: "USDT-TRY", tdMode: "cash", side: "buy", ordType: "post_only", px: "49.447", clOrdId: "plt7" });
    expect(o.sz).toBe(limitBuySz({ amountTL: 10000, pxE6: 49_447_000, lotSz: "0.0001", minSz: "1" }));
    expect(notionalTLE6(o.sz, pxToPxE6(o.px))).toBeLessThanOrEqual(10000n * 1_000_000n);
    expect(onDiskAtPlace).toBe("PLACED"); // durum emirden ÖNCE diskte
    expect(h.chain.reports).toHaveLength(1);
    expect(h.chain.reports[0]).toMatchObject({ actionId: "7", status: "FILLED", ordId: "ord-1" });
    expect(h.chain.reports[0]!.filledTL).toBeLessThanOrEqual(10000);
    expect(r.reportTx).toBeDefined();
    expect(diskRecord(h, "7")?.state).toBe("REPORTED");
  });

  it("U-14 ioc: px = bestAsk (tick'e aşağı), maxPx altındaysa emir gider", async () => {
    const h = setup();
    h.exchange.ask = "49.462";
    h.chain.seed("8", { ordType: "ioc", maxPxE6: 49_500_000 });
    const r = await h.executor.execute(PILOT, "8");
    expect(r.verdict).toBe("ONAY");
    expect(h.exchange.placed[0]).toMatchObject({ ordType: "ioc", px: "49.462" });
  });

  it("U-6 ioc ve bestAsk > maxPx → BEKLET ABOVE_MAX_PX; emir yok, kayıt silinir (yeniden denenebilir), izin serbest bırakılmaz", async () => {
    const h = setup();
    h.chain.seed("9", { ordType: "ioc", maxPxE6: 49_400_000 });
    const r = await h.executor.execute(PILOT, "9");
    expect(r.verdict).toBe("BEKLET");
    expect(r.reasons).toEqual(["ABOVE_MAX_PX"]);
    expect(r.status).toBe("NOT_PLACED");
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.store.get("9")).toBeUndefined();
    expect(h.chain.reports).toHaveLength(0);
    // fiyat düşünce aynı izin uygulanabilir
    h.exchange.ask = "49.390";
    h.exchange.bid = "49.380";
    const r2 = await h.executor.execute(PILOT, "9");
    expect(r2.verdict).toBe("ONAY");
  });

  it("U-4 izni olmayan actionId → RET NO_AUTHORIZATION; diske kayıt yazılmaz, emir yok", async () => {
    const h = setup();
    const r = await h.executor.execute(PILOT, "12345");
    expect(r).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"], status: "NOT_PLACED" });
    expect(h.store.all()).toHaveLength(0);
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("U-5 süresi dolmuş / raporlanmış izin → RET NO_AUTHORIZATION", async () => {
    const h = setup();
    h.chain.seed("20", { state: "EXPIRED" });
    h.chain.seed("21", { state: "REPORTED" });
    for (const id of ["20", "21"]) {
      const r = await h.executor.execute(PILOT, id);
      expect(r).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    }
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.chain.reports).toHaveLength(0); // AUTHORIZED olmayan izin için rapor denenmez
  });

  it("U-13 openBy − now < 12 dk → RET TOO_LATE ve izin hemen serbest bırakılır (CANCELED rapor, ordId boş)", async () => {
    const h = setup();
    h.chain.seed("30", { openBy: Math.floor(T0 / 1000) + 12 * 60 - 1 });
    const r = await h.executor.execute(PILOT, "30");
    expect(r).toMatchObject({ verdict: "RET", reasons: ["TOO_LATE"], status: "NOT_PLACED" });
    expect(r.reportTx).toBeDefined();
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.chain.reports).toHaveLength(1);
    expect(h.chain.reports[0]).toMatchObject({ actionId: "30", ordId: "", filledTL: 0, avgPxE6: 0, status: "CANCELED" });
    expect(h.chain.reports[0]!.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(diskRecord(h, "30")?.state).toBe("REPORTED");
    // ikinci çağrı: zincir da REPORTED, KULE da biliyor
    const r2 = await h.executor.execute(PILOT, "30");
    expect(r2.verdict).toBe("RET");
    expect(h.chain.reports).toHaveLength(1);
  });

  it("U-13 sınır: openBy − now tam 12 dk ise uygulanır", async () => {
    const h = setup();
    h.chain.seed("31", { openBy: Math.floor(T0 / 1000) + 12 * 60 });
    expect((await h.executor.execute(PILOT, "31")).verdict).toBe("ONAY");
  });

  it("U-15 TRY yalnız fon hesabında → RET BALANCE_IN_FUNDING; hiç yoksa BALANCE; emir yok, izin serbest", async () => {
    const h = setup();
    h.exchange.balance = { TRY: { trading: "0", funding: "20000" }, USDT: { trading: "0", funding: "0" } };
    h.chain.seed("40");
    const r = await h.executor.execute(PILOT, "40");
    expect(r).toMatchObject({ verdict: "RET", reasons: ["BALANCE_IN_FUNDING"] });
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.chain.reports[0]).toMatchObject({ actionId: "40", status: "CANCELED" });

    h.exchange.balance = { TRY: { trading: "9999.99", funding: "0" }, USDT: { trading: "0", funding: "0" } };
    h.chain.seed("41");
    const r2 = await h.executor.execute(PILOT, "41");
    expect(r2).toMatchObject({ verdict: "RET", reasons: ["BALANCE"] });
  });

  it("U-12 başka ajana bağlı token → RET WRONG_AGENT; ajansız token da; geçersiz token AUTH; diske kilit yazılmaz", async () => {
    const h = setup();
    h.chain.seed("50");
    expect(await h.executor.execute(OTHER, "50")).toMatchObject({ verdict: "RET", reasons: ["WRONG_AGENT"] });
    expect(await h.executor.execute(DEMO, "50")).toMatchObject({ verdict: "RET", reasons: ["WRONG_AGENT"] });
    expect(await h.executor.execute(null, "50")).toMatchObject({ verdict: "RET", reasons: ["AUTH"] });
    expect(h.store.all()).toHaveLength(0);
    expect(h.exchange.placed).toHaveLength(0);
    // gerçek sahip hâlâ uygulayabilir (kilit yakılmadı)
    expect((await h.executor.execute(PILOT, "50")).verdict).toBe("ONAY");
  });

  it("U-10 aynı actionId için eşzamanlı iki (ve beş) kule_execute → yalnız biri emir açar, diğerleri ALREADY_EXECUTED", async () => {
    const h = setup();
    h.chain.seed("60");
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => h.executor.execute(PILOT, "60")));
    expect(rs.filter((r) => r.verdict === "ONAY")).toHaveLength(1);
    const dup = rs.filter((r) => r.verdict === "RET");
    expect(dup).toHaveLength(4);
    for (const d of dup) expect(d.reasons).toEqual(["ALREADY_EXECUTED"]);
    expect(h.exchange.placed).toHaveLength(1);
    expect(h.chain.reports).toHaveLength(1);
    // sonradan çağrı da aynı
    expect((await h.executor.execute(PILOT, "60")).reasons).toEqual(["ALREADY_EXECUTED"]);
  });
});

describe("kule_execute: sağlık (§9.3)", () => {
  it("U-9 RPC hatası → BEKLET HEALTH:CHAIN_UNREADABLE ve durum YENİ_EMİR_YOK", async () => {
    const h = setup();
    h.chain.seed("70");
    h.chain.unreadable = true;
    const r = await h.executor.execute(PILOT, "70");
    expect(r).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:CHAIN_UNREADABLE"] });
    expect(h.exchange.placed).toHaveLength(0);
    const st = await h.service.call("kule_status", {}, PILOT);
    expect(st).toMatchObject({ health: "YENİ_EMİR_YOK", chain: { ok: false, block: null } });
    h.chain.unreadable = false;
    expect((await h.executor.execute(PILOT, "70")).verdict).toBe("ONAY"); // geçici hata izni yakmadı
  });

  it("U-8 kalp atışı 45 sn kesilince CAA yenilemesi durur, durum YENİ_EMİR_YOK, kule_execute BEKLET", async () => {
    const h = setup();
    h.chain.seed("71");
    const sets: number[] = [];
    const loop = new CaaLoop({
      client: { set: async (n: number) => void sets.push(n) },
      clock: h.clock,
      logger: h.logger,
      isNormal: () => h.health.isNormalForCaa(),
    });
    expect(await loop.tick()).toBe(true);
    expect(sets).toEqual([60]);
    h.clock.advance(20_000);
    h.heartbeats.beat("pilot");
    expect(await loop.tick()).toBe(true);
    // PİLOT susar: 46 sn
    h.clock.advance(46_000);
    expect(await loop.tick()).toBe(false);
    expect(sets).toEqual([60, 60]); // yeni yenileme yok
    const st = (await h.service.call("kule_status", {}, PILOT)) as { health: string; reasons: string[]; pilotHeartbeatAgeSec: number };
    expect(st.health).toBe("YENİ_EMİR_YOK");
    expect(st.reasons).toContain("HEALTH:PILOT_HEARTBEAT");
    expect(st.pilotHeartbeatAgeSec).toBeGreaterThan(45);
    expect(await h.executor.execute(PILOT, "71")).toMatchObject({ verdict: "BEKLET", reasons: expect.arrayContaining(["HEALTH:PILOT_HEARTBEAT"]) });
    await loop.stop();
    expect(sets.at(-1)).toBe(0); // kapanışta timeOut 0
  });

  it("hiç kalp atışı gelmediyse (null) fail-closed: BEKLET HEALTH:PILOT_HEARTBEAT", async () => {
    const h = setup();
    h.chain.seed("72");
    const fresh = makeHarnessWithoutBeats();
    fresh.chain.seed("72");
    expect(await fresh.executor.execute(PILOT, "72")).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:PILOT_HEARTBEAT"] });
  });

  it("kalp atışı çağıranın kendisinindir: başka ajanın kalp atışı PİLOT'u kurtarmaz", async () => {
    const h = setup();
    h.chain.seed("73");
    h.clock.advance(60_000);
    h.heartbeats.beat("agent2"); // yalnız agent2 canlı
    const r = await h.executor.execute(PILOT, "73");
    expect(r).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:PILOT_HEARTBEAT"] });
  });

  it("veri bayat (>5 sn) → BEKLET HEALTH:DATA_STALE; kayıt silinir; emir yok", async () => {
    const h = setup();
    h.chain.seed("74");
    h.exchange.ageMs = 6000;
    expect(await h.executor.execute(PILOT, "74")).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:DATA_STALE"] });
    expect(h.store.get("74")).toBeUndefined();
    expect(h.exchange.placed).toHaveLength(0);
    h.exchange.marketDown = true;
    expect(await h.executor.execute(PILOT, "74")).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:DATA_STALE"] });
  });

  it("adım 8: sağlık geçtikten sonra veri 5 sn'yi aşarsa BEKLET STALE_DATA", async () => {
    const h = setup();
    h.chain.seed("75");
    h.exchange.ageMs = 4900;
    h.exchange.onBalanceRead = () => h.clock.advance(600); // bakiye okunurken veri eskir
    expect(await h.executor.execute(PILOT, "75")).toMatchObject({ verdict: "BEKLET", reasons: ["STALE_DATA"] });
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("makas > 30 bp → BEKLET WIDE_SPREAD", async () => {
    const h = setup();
    h.chain.seed("76");
    h.exchange.bid = "49.000";
    h.exchange.ask = "49.500"; // ~102 bp
    expect(await h.executor.execute(PILOT, "76")).toMatchObject({ verdict: "BEKLET", reasons: ["WIDE_SPREAD"] });
  });

  it("CAA yenilenemiyorsa (okx modu) yeni emir yok: BEKLET HEALTH:CAA_INACTIVE", async () => {
    const h = setup();
    h.chain.seed("77");
    h.caa.active = false;
    expect(await h.executor.execute(PILOT, "77")).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:CAA_INACTIVE"] });
  });

  it("plan iptal edilmiş → RET NO_AUTHORIZATION (YETKİ_YOK); kule_status YETKİ_YOK", async () => {
    const h = setup();
    h.chain.seed("78");
    h.chain.planActive = false;
    expect(await h.executor.execute(PILOT, "78")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(await h.service.call("kule_status", {}, PILOT)).toMatchObject({ health: "YETKİ_YOK" });
    expect(h.exchange.placed).toHaveLength(0);
  });
});

describe("kule_execute: yetki bağı (saldırgan senaryolar)", () => {
  it("yabancı kullanıcının planı (saldırgan kendi planıyla Elif'in hesabında emir açtırmak ister) → RET NO_AUTHORIZATION; kilit yok, emir yok", async () => {
    const h = setup();
    h.chain.seed("80", { amountTL: 40000 }, {}, FOREIGN_USER);
    const r = await h.executor.execute(PILOT, "80");
    expect(r).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(h.store.all()).toHaveLength(0);
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.chain.reports).toHaveLength(0);
  });

  it("plan.kule bu KULE'nin raportör adresi değil → RET NO_AUTHORIZATION", async () => {
    const h = setup();
    h.chain.seed("81", {}, { kule: FOREIGN_KULE });
    expect(await h.executor.execute(PILOT, "81")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("plan.agent token'ın ajanından farklı → WRONG_AGENT; plan.agent başkası iken o ajanın token'ı uygulayabilir (yalnız kendi planı)", async () => {
    const h = setup();
    h.chain.seed("82", {}, { agent: AGENT2, agentId: "2" });
    expect(await h.executor.execute(PILOT, "82")).toMatchObject({ reasons: ["WRONG_AGENT"] });
    expect((await h.executor.execute(OTHER, "82")).verdict).toBe("ONAY");
  });

  it("ERC-8004: agentWallet(agentId) ≠ plans(user).agent → RET NO_AUTHORIZATION", async () => {
    const h = setup();
    h.chain.seed("83");
    h.chain.wallets.set("1", AGENT2); // kimlik başka cüzdana bağlı
    const r = await h.executor.execute(PILOT, "83");
    expect(r).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(h.store.all()).toHaveLength(0);
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("ERC-8004: agentWallet baytları bozuk ya da kimlik kayıtsız → fail-closed RET NO_AUTHORIZATION", async () => {
    const h = setup();
    h.chain.seed("84");
    h.chain.walletInvalid = true;
    expect(await h.executor.execute(PILOT, "84")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    h.chain.walletInvalid = false;
    h.chain.wallets.delete("1");
    expect(await h.executor.execute(PILOT, "84")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("eski plan izni: BuyAuthorized, kullanıcının son PlanSet/PlanRevoked/commitPending'inden eskiyse → RET NO_AUTHORIZATION", async () => {
    const h = setup();
    h.chain.seed("85");
    h.chain.freshness.set("85", "stale");
    expect(await h.executor.execute(PILOT, "85")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    h.chain.seed("86");
    h.chain.freshness.set("86", "unknown"); // log bulunamadı → fail-closed
    expect(await h.executor.execute(PILOT, "86")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(h.exchange.placed).toHaveLength(0);
    h.chain.seed("87");
    expect((await h.executor.execute(PILOT, "87")).verdict).toBe("ONAY");
  });

  it("geçersiz actionId (çok uzun) araç hatası fırlatır; kayıt yazılmaz", async () => {
    const h = setup();
    await expect(h.executor.execute(PILOT, "1".repeat(40))).rejects.toThrow();
    expect(h.store.all()).toHaveLength(0);
  });
});

describe("kule_execute: emir sonuçları, belirsizlik, rapor", () => {
  it("post_only dolmazsa 10 dk bekler, iptal eder, EXPIRED rapor yazar", async () => {
    const h = setup();
    h.exchange.behavior = "rest";
    h.chain.seed("90");
    const t0 = h.clock.ms;
    const r = await h.executor.execute(PILOT, "90");
    expect(r).toMatchObject({ verdict: "ONAY", status: "EXPIRED" });
    expect(h.clock.ms - t0).toBeGreaterThanOrEqual(10 * 60_000);
    expect(h.exchange.cancels).toEqual(["plt90"]);
    expect(h.chain.reports[0]).toMatchObject({ status: "EXPIRED", filledTL: 0, avgPxE6: 0 });
  });

  it("post_only kısmi dolum: süre sonunda iptal, PARTIAL rapor, filledTL ≤ amountTL", async () => {
    const h = setup();
    h.exchange.behavior = "rest";
    h.exchange.restFill = "50";
    h.chain.seed("91");
    const r = await h.executor.execute(PILOT, "91");
    expect(r.status).toBe("PARTIAL");
    expect(h.chain.reports[0]).toMatchObject({ status: "PARTIAL", filledTL: Math.floor(50 * 49.447), avgPxE6: 49_447_000 });
  });

  it("reportHash = keccak256(günlük satırı); günlükte token ve gizli değer yok", async () => {
    const h = setup();
    h.chain.seed("92");
    await h.executor.execute(PILOT, "92");
    const line = h.logger.lines.find((l) => (JSON.parse(l) as { event?: string }).event === "execution");
    expect(line).toBeDefined();
    expect(h.chain.reports[0]!.reportHash).toBe(keccak256(stringToBytes(line!)));
    const all = h.logger.lines.join("\n");
    expect(all).not.toContain(PILOT.token);
    expect(all).not.toMatch(/secret|passphrase|privateKey/i);
  });

  it("OKX kesin ret (EXCHANGE_REJECTED) → RET, izin serbest, kayıt REPORTED(released); tekrar çağrı ALREADY_EXECUTED", async () => {
    const h = setup();
    h.exchange.behavior = "reject";
    h.chain.seed("93");
    const r = await h.executor.execute(PILOT, "93");
    expect(r).toMatchObject({ verdict: "RET", reasons: ["EXCHANGE_REJECTED"], status: "NOT_PLACED" });
    expect(h.chain.reports[0]).toMatchObject({ actionId: "93", status: "CANCELED" });
    expect(h.store.get("93")).toMatchObject({ state: "REPORTED", released: true });
    expect((await h.executor.execute(PILOT, "93")).reasons).toEqual(["ALREADY_EXECUTED"]);
  });

  it("zaman aşımı ama emir borsada → get-order ile netleşir, tek emir, raporlanır", async () => {
    const h = setup();
    h.exchange.behavior = "timeout-landed";
    h.chain.seed("94");
    const r = await h.executor.execute(PILOT, "94");
    expect(r).toMatchObject({ verdict: "ONAY", status: "FILLED" });
    expect(h.exchange.placed).toHaveLength(1);
    expect(h.chain.reports).toHaveLength(1);
    expect(h.store.anyUncertain()).toBe(false);
  });

  it("zaman aşımı ve emir yok → BEKLET UNCERTAIN_RESULT; netleşene kadar YENİ_EMİR_YOK (başka izinler de); süre sonunda mutabakat serbest bırakır", async () => {
    const h = setup({ tuning: { uncertainGraceMs: 90_000 } });
    h.exchange.behavior = "timeout-lost";
    h.chain.seed("95");
    h.chain.seed("96");
    const r = await h.executor.execute(PILOT, "95");
    expect(r).toMatchObject({ verdict: "BEKLET", reasons: ["UNCERTAIN_RESULT"], status: "NOT_PLACED" });
    expect(h.store.get("95")).toMatchObject({ state: "PLACED", uncertain: true });
    expect(await h.service.call("kule_status", {}, PILOT)).toMatchObject({ health: "YENİ_EMİR_YOK", reasons: expect.arrayContaining(["HEALTH:ORDER_UNCERTAIN"]) });

    h.exchange.behavior = "fill";
    expect(await h.executor.execute(PILOT, "96")).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:ORDER_UNCERTAIN"] });
    expect(h.exchange.placed).toHaveLength(1); // yalnız ilk (belirsiz) deneme

    // bekleme süresi dolmadan: hâlâ belirsiz
    expect(await h.executor.reconcile()).toEqual({ resolved: 0, pending: 1 });
    h.clock.advance(120_000);
    h.heartbeats.beat("pilot");
    expect(await h.executor.reconcile()).toEqual({ resolved: 1, pending: 0 });
    expect(h.store.anyUncertain()).toBe(false);
    expect(h.chain.reports[0]).toMatchObject({ actionId: "95", status: "CANCELED" });
    expect((await h.executor.execute(PILOT, "96")).verdict).toBe("ONAY");
  });

  it("reportExecution başarısız → ONAY ama reportTx yok, kayıt DONE; zincir düzelince mutabakat raporlar (aynı reportHash)", async () => {
    const h = setup();
    h.chain.seed("97");
    h.chain.reportFails = "revert";
    const r = await h.executor.execute(PILOT, "97");
    expect(r.verdict).toBe("ONAY");
    expect(r.reportTx).toBeUndefined();
    expect(h.store.get("97")).toMatchObject({ state: "DONE" });
    const hash = h.store.get("97")!.reportHash;
    h.chain.reportFails = "none";
    expect(await h.executor.reconcile()).toEqual({ resolved: 1, pending: 0 });
    expect(h.store.get("97")).toMatchObject({ state: "REPORTED" });
    expect(h.chain.reports[0]!.reportHash).toBe(hash);
  });
});

describe("yeniden başlatma (§9.2-2)", () => {
  it("U-11 KULE PLACED'de yeniden başlar → clOrdId ile emri bulur, ikinci emir açmaz, raporlar", async () => {
    const h1 = setup();
    h1.chain.seed("100");
    const now = h1.clock.ms;
    await h1.store.reserve({ actionId: "100", clOrdId: "plt100", state: "RESERVED", agent: PILOT.agent!.toLowerCase(), paper: false, amountTL: 10000, reservedAtMs: now, updatedAtMs: now });
    await h1.store.update("100", { state: "PLACED", ordType: "post_only", pxE6: 49_447_000, sz: "202.2", placedAtMs: now }, now);
    // emir borsada dolmuş (süreç ölmeden önce gitmişti)
    h1.exchange.injectOrder({ ordId: "ord-x", clOrdId: "plt100", state: "filled", sz: "202.2", px: "49.447", accFillSz: "202.2", avgPx: "49.447" });

    const h2 = h1.restart();
    expect(h2.store.get("100")).toMatchObject({ state: "PLACED", uncertain: true });
    expect(await h2.service.call("kule_status", {}, PILOT)).toMatchObject({ health: "YENİ_EMİR_YOK" }); // mutabakat bitene kadar
    expect(await h2.executor.reconcile()).toEqual({ resolved: 1, pending: 0 });
    expect(h2.exchange.placed).toHaveLength(0); // ikinci emir yok
    expect(h2.chain.reports).toHaveLength(1);
    expect(h2.chain.reports[0]).toMatchObject({ actionId: "100", ordId: "ord-x", status: "FILLED", filledTL: Math.floor(202.2 * 49.447) });
    expect(h2.store.get("100")).toMatchObject({ state: "REPORTED" });
    expect((await h2.executor.execute(PILOT, "100")).reasons).toEqual(["ALREADY_EXECUTED"]);
    expect(h2.exchange.placed).toHaveLength(0);
    // başka süreç yeniden okusa da aynı
    const h3 = h2.restart();
    expect(h3.store.get("100")).toMatchObject({ state: "REPORTED" });
  });

  it("PLACED'de yeniden başlama ve emir tahtada duruyor → kalan süre izlenir, iptal edilir, PARTIAL raporlanır", async () => {
    const h1 = setup();
    h1.chain.seed("101");
    const now = h1.clock.ms;
    await h1.store.reserve({ actionId: "101", clOrdId: "plt101", state: "RESERVED", agent: PILOT.agent!.toLowerCase(), paper: false, amountTL: 10000, reservedAtMs: now, updatedAtMs: now });
    await h1.store.update("101", { state: "PLACED", ordType: "post_only", pxE6: 49_447_000, sz: "202.2", placedAtMs: now }, now);
    h1.exchange.injectOrder({ ordId: "ord-y", clOrdId: "plt101", state: "live", sz: "202.2", px: "49.447", accFillSz: "0", avgPx: "" });
    h1.exchange.restFill = "10";
    const h2 = h1.restart();
    await h2.executor.reconcile();
    expect(h2.exchange.placed).toHaveLength(0);
    expect(h2.exchange.cancels).toEqual(["plt101"]);
    expect(h2.chain.reports[0]).toMatchObject({ actionId: "101", status: "PARTIAL" });
  });

  it("RESERVED kalmış ve borsada emir yok → kayıt silinir (yeniden denenebilir)", async () => {
    const h1 = setup();
    h1.chain.seed("102");
    const now = h1.clock.ms;
    await h1.store.reserve({ actionId: "102", clOrdId: "plt102", state: "RESERVED", agent: PILOT.agent!.toLowerCase(), paper: false, amountTL: 10000, reservedAtMs: now, updatedAtMs: now });
    const h2 = h1.restart();
    expect(await h2.executor.reconcile()).toEqual({ resolved: 1, pending: 0 });
    expect(h2.store.get("102")).toBeUndefined();
    expect((await h2.executor.execute(PILOT, "102")).verdict).toBe("ONAY");
  });

  it("get-order başarısız → kayıt belirsiz kalır, yeni emir yok", async () => {
    const h1 = setup();
    h1.chain.seed("103");
    h1.chain.seed("104");
    const now = h1.clock.ms;
    await h1.store.reserve({ actionId: "103", clOrdId: "plt103", state: "RESERVED", agent: PILOT.agent!.toLowerCase(), paper: false, amountTL: 10000, reservedAtMs: now, updatedAtMs: now });
    await h1.store.update("103", { state: "PLACED", ordType: "post_only", pxE6: 49_447_000, sz: "202.2", placedAtMs: now }, now);
    const h2 = h1.restart();
    h2.exchange.getOrderFails = true;
    expect(await h2.executor.reconcile()).toEqual({ resolved: 0, pending: 1 });
    expect(await h2.executor.execute(PILOT, "104")).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:ORDER_UNCERTAIN"] });
  });
});

describe("kâğıt modu (KULE_EXEC=paper)", () => {
  it("U-7 borsaya emir gitmez, rapor paper etiketli, readback KÂĞIT, günlükte paper:true", async () => {
    const h = setup({ paper: true });
    h.chain.seed("110", { ordType: "ioc" });
    h.exchange.balance = { TRY: { trading: "0", funding: "0" }, USDT: { trading: "0", funding: "0" } }; // bakiye olmasa da kâğıt çalışır
    const r = await h.executor.execute(PILOT, "110");
    expect(r).toMatchObject({ verdict: "ONAY", status: "FILLED", paper: true, ordId: "paper-110" });
    expect(r.readback).toContain("KÂĞIT");
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.exchange.cancels).toHaveLength(0);
    expect(h.chain.reports).toHaveLength(1);
    expect(h.chain.reports[0]).toMatchObject({ actionId: "110", ordId: "paper-110", status: "FILLED", avgPxE6: 49_462_000 }); // ioc: bestAsk'ten
    const exec = h.logger.records().find((x) => x.event === "execution");
    expect(exec).toMatchObject({ paper: true });
  });

  it("kâğıt modunda da zincir bağı geçerli: yabancı plan RET, hiçbir koruma kapanmaz", async () => {
    const h = setup({ paper: true });
    h.chain.seed("111", {}, {}, FOREIGN_USER);
    expect(await h.executor.execute(PILOT, "111")).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"], paper: true });
    h.chain.seed("112", { openBy: Math.floor(T0 / 1000) + 60 });
    expect(await h.executor.execute(PILOT, "112")).toMatchObject({ reasons: ["TOO_LATE"] });
  });

  it("kâğıt modunda CAA gerekmez (CAA_INACTIVE sebebi yok)", async () => {
    const h = setup({ paper: true });
    h.caa.active = false;
    const st = (await h.service.call("kule_status", {}, PILOT)) as { reasons: string[]; mode: string; caa: { active: boolean } };
    expect(st.reasons).not.toContain("HEALTH:CAA_INACTIVE");
    expect(st.mode).toBe("paper");
    expect(st.caa.active).toBe(false);
  });
});

describe("kule_cancel", () => {
  async function withLiveOrder(h: Harness, id: string, agent = PILOT.agent!) {
    h.chain.seed(id);
    const now = h.clock.ms;
    await h.store.reserve({ actionId: id, clOrdId: `plt${id}`, state: "RESERVED", agent: agent.toLowerCase(), paper: false, amountTL: 10000, reservedAtMs: now, updatedAtMs: now });
    await h.store.update(id, { state: "PLACED", ordType: "post_only", pxE6: 49_447_000, sz: "202.2", placedAtMs: now }, now);
    h.exchange.injectOrder({ ordId: `o${id}`, clOrdId: `plt${id}`, state: "live", sz: "202.2", px: "49.447", accFillSz: "0", avgPx: "" });
  }

  it("kendi izninin emrini iptal eder; başka ajan iptal edemez (WRONG_AGENT); izinsiz actionId NO_AUTHORIZATION", async () => {
    const h = setup();
    await withLiveOrder(h, "120");
    expect(await h.executor.cancel(OTHER, { actionId: "120" })).toMatchObject({ ok: false, reasons: ["WRONG_AGENT"] });
    expect(await h.executor.cancel(DEMO, { actionId: "120" })).toMatchObject({ ok: false, reasons: ["WRONG_AGENT"] });
    expect(await h.executor.cancel(null, { actionId: "120" })).toMatchObject({ ok: false, reasons: ["AUTH"] });
    expect(await h.executor.cancel(PILOT, { actionId: "999" })).toMatchObject({ ok: false, reasons: ["NO_AUTHORIZATION"] });
    expect(h.exchange.cancels).toHaveLength(0);
    expect(await h.executor.cancel(PILOT, { actionId: "120" })).toEqual({ ok: true, canceled: ["plt120"], reasons: [] });
    expect(h.exchange.cancels).toEqual(["plt120"]);
  });

  it("all:true yalnız çağıran ajanın KULE emirlerini iptal eder", async () => {
    const h = setup();
    await withLiveOrder(h, "121");
    await withLiveOrder(h, "122", AGENT2);
    h.exchange.injectOrder({ ordId: "manual", clOrdId: "elle-emir", state: "live", sz: "1", px: "49", accFillSz: "0", avgPx: "" }); // Bekir'in elle emri
    const r = await h.executor.cancel(PILOT, { all: true });
    expect(r).toEqual({ ok: true, canceled: ["plt121"], reasons: [] });
    expect(h.exchange.cancels).toEqual(["plt121"]);
  });
});

function makeHarnessWithoutBeats(): Harness {
  const h = makeHarness();
  hs.push(h);
  // yeni harness'ta kalp atışı yok: HeartbeatBook'u boş yeniden kur
  const empty = makeHarness({ reuse: { clock: h.clock, chain: h.chain, exchange: h.exchange, logger: h.logger, caa: h.caa }, dir: h.dir });
  (empty.heartbeats as unknown as { last: Map<string, number> }).last.clear();
  void USER;
  return empty;
}
