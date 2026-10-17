/** Kapanış (app.stop / executor.shutdown): açık emirler iptal edilir; canlı/belirsiz emir kalırsa CAA geri sayımı KAPATILMAZ. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { KuleConfig } from "../src/config.js";
import { MemoryLogger } from "../src/logger.js";
import { DEMO, FakeChain, FakeExchange, OTHER, PILOT, REPORTER, T0, TestClock, USER, fakeInstrumentsFetch, makeHarness, type Harness } from "./helpers.js";

const hs: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (hs.length) hs.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function placedRecord(store: Harness["store"], actionId: string): Promise<void> {
  await store.reserve({ actionId, clOrdId: `plt${actionId}`, state: "RESERVED", agent: PILOT.agent!.toLowerCase(), paper: false, amountTL: 10000, reservedAtMs: T0, updatedAtMs: T0 });
  await store.update(actionId, { state: "PLACED", ordType: "post_only", pxE6: 49_447_000, sz: "202.2", placedAtMs: T0, ordId: "ord-x" }, T0);
}
const liveOrder = (clOrdId: string) => ({ ordId: "ord-x", clOrdId, state: "live" as const, sz: "202.2", px: "49.447", accFillSz: "0", avgPx: "" });

describe("executor.shutdown", () => {
  it("U-8 canlı plt* emrini iptal eder; emir terminal olunca safe=true; plt olmayan emre dokunmaz", async () => {
    const h = makeHarness();
    hs.push(h);
    await placedRecord(h.store, "71");
    h.exchange.injectOrder(liveOrder("plt71"));
    h.exchange.injectOrder({ ...liveOrder("manual-1"), ordId: "m1" });
    const r = await h.executor.shutdown(50);
    expect(r).toMatchObject({ safe: true, canceled: ["plt71"] });
    expect(h.exchange.cancels).toEqual(["plt71"]);
    expect((await h.exchange.getOrder("plt71"))!.state).toBe("canceled");
    expect((await h.exchange.getOrder("manual-1"))!.state).toBe("live");
  });

  it("U-8 iptal başarısız ve emir canlı kalırsa safe=false", async () => {
    const h = makeHarness();
    hs.push(h);
    await placedRecord(h.store, "72");
    h.exchange.injectOrder(liveOrder("plt72"));
    h.exchange.cancelOrder = async () => {
      throw new Error("iptal başarısız");
    };
    const r = await h.executor.shutdown(50);
    expect(r.safe).toBe(false);
    expect(r.reasons).toContain("unresolved:72");
  });

  it("U-8 PLACED kayıt ve borsada emir bulunamıyor (yanıt kaybolmuş olabilir) → safe=false; get-order okunamıyorsa da safe=false", async () => {
    const h = makeHarness();
    hs.push(h);
    await placedRecord(h.store, "73");
    expect((await h.executor.shutdown(50)).reasons).toContain("unresolved:73");
    h.exchange.getOrderFails = true;
    expect((await h.executor.shutdown(50)).reasons).toContain("unverified:73");
  });

  it("U-8 kapanış başladıktan sonra yeni kule_execute alınmaz (BEKLET, emir yok)", async () => {
    const h = makeHarness();
    hs.push(h);
    h.chain.seed("74");
    await h.executor.shutdown(50);
    const r = await h.executor.execute(PILOT, "74");
    expect(r).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:CAA_INACTIVE"], status: "NOT_PLACED" });
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("U-8 süren kule_execute drainMs içinde bitmezse safe=false (in_flight)", async () => {
    const h = makeHarness();
    hs.push(h);
    h.chain.seed("75");
    const orig = h.chain.readAction.bind(h.chain);
    let calls = 0;
    // ilk okuma (kilit öncesi) hızlı; ikinci okuma (kilit sonrası, inFlight içinde) yavaş
    h.chain.readAction = async (id) => {
      calls++;
      if (calls >= 2) await new Promise((r) => setTimeout(r, 300));
      return orig(id);
    };
    const exec = h.executor.execute(PILOT, "75");
    await new Promise((r) => setTimeout(r, 50));
    const r = await h.executor.shutdown(30);
    expect(r.reasons).toContain("in_flight");
    expect(r.safe).toBe(false);
    await exec.catch(() => undefined);
  });
});

describe("app.stop: CAA geri sayımı", () => {
  async function mkApp(): Promise<{ app: Awaited<ReturnType<typeof createApp>>; sets: number[]; exchange: FakeExchange }> {
    const dir = mkdtempSync(join(tmpdir(), "kule-stop-"));
    dirs.push(dir);
    const clock = new TestClock();
    const exchange = new FakeExchange(clock);
    const sets: number[] = [];
    const cfg: KuleConfig = {
      port: 0,
      tokens: [PILOT, DEMO, OTHER],
      planUser: USER,
      okxProfile: "kule-demo",
      exec: "okx",
      okx: null,
      demo: true,
      mode: "demo",
      reporterKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      reporter: REPORTER,
      rpcUrl: "http://127.0.0.1:1",
      deployments: {} as never,
      actionsPath: join(dir, "data", "kule-actions.json"),
      logDir: join(dir, "logs"),
    };
    const app = await createApp(cfg, {
      exchange,
      chain: new FakeChain(clock),
      clock,
      logger: new MemoryLogger(clock),
      fetchImpl: fakeInstrumentsFetch,
      port: 0,
      caaClient: { set: async (n: number) => void sets.push(n) },
      sleep: async (ms) => void clock.advance(ms),
    });
    await app.start();
    return { app, sets, exchange };
  }

  it("U-8 temiz kapanış: açık emir yok → timeOut 0 gönderilir", async () => {
    const { app, sets } = await mkApp();
    await app.stop();
    expect(sets.at(-1)).toBe(0);
  });

  it("U-8 iptal edilemeyen canlı emir varken kapanış timeOut 0 GÖNDERMEZ (60 sn geri sayım emri iptal etsin)", async () => {
    const { app, sets, exchange } = await mkApp();
    await placedRecord(app.store, "76");
    exchange.injectOrder(liveOrder("plt76"));
    exchange.cancelOrder = async () => {
      throw new Error("iptal başarısız");
    };
    await app.stop();
    expect(sets).not.toContain(0);
    expect(app.caa!.isActive()).toBe(false); // yenileme durdu → yeni emir yok
  });

  it("U-8 canlı plt* emir varken kapanış önce iptal eder, sonra timeOut 0 gönderir", async () => {
    const { app, sets, exchange } = await mkApp();
    await placedRecord(app.store, "77");
    exchange.injectOrder(liveOrder("plt77"));
    await app.stop();
    expect(exchange.cancels).toContain("plt77");
    expect(sets.at(-1)).toBe(0);
  });
});
