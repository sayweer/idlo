import { describe, expect, it } from "vitest";
import { CAA_PATH, CaaClient, CaaLoop, okxSign } from "../src/caa.js";
import { MemoryLogger } from "../src/logger.js";
import { TestClock } from "./helpers.js";

const CREDS = { apiKey: "fake-api-key", secretKey: "fake-secret-for-tests", passphrase: "fake-passphrase" };

describe("Cancel-All-After REST istemcisi (§9.3)", () => {
  it("imza sabit sahte kimlik bilgisiyle bilinen değeri verir: base64(HMAC_SHA256(secret, ts+method+path+body))", () => {
    const ts = "2026-10-17T12:00:00.000Z";
    expect(okxSign(CREDS.secretKey, ts, "POST", CAA_PATH, JSON.stringify({ timeOut: "60" }))).toBe("Uui581alA+nFTvV6YVRlVgHeOhPrjvSGOn7zfAw40Cw=");
    expect(okxSign(CREDS.secretKey, ts, "POST", CAA_PATH, JSON.stringify({ timeOut: "0" }))).toBe("eK6j6u/HmEcx10n2Nx5mevmyhHp8pkNOb0hWEQcJOvI=");
    // her bileşen imzayı değiştirir
    const base = okxSign(CREDS.secretKey, ts, "POST", CAA_PATH, "{}");
    expect(okxSign("baska", ts, "POST", CAA_PATH, "{}")).not.toBe(base);
    expect(okxSign(CREDS.secretKey, ts + " ", "POST", CAA_PATH, "{}")).not.toBe(base);
    expect(okxSign(CREDS.secretKey, ts, "GET", CAA_PATH, "{}")).not.toBe(base);
    expect(okxSign(CREDS.secretKey, ts, "POST", CAA_PATH + "x", "{}")).not.toBe(base);
    expect(okxSign(CREDS.secretKey, ts, "POST", CAA_PATH, "{ }")).not.toBe(base);
  });

  it("başlıklar ve gövde: OK-ACCESS-* ve demo için x-simulated-trading:1; gerçek hesapta yok", () => {
    const clock = new TestClock(Date.parse("2026-10-17T12:00:00.000Z"));
    const demo = new CaaClient({ creds: CREDS, demo: true, clock }).buildRequest(60);
    expect(demo.url).toBe("https://tr.okx.com/api/v5/trade/cancel-all-after");
    expect(demo.body).toBe('{"timeOut":"60"}');
    expect(demo.headers).toMatchObject({
      "OK-ACCESS-KEY": "fake-api-key",
      "OK-ACCESS-SIGN": "Uui581alA+nFTvV6YVRlVgHeOhPrjvSGOn7zfAw40Cw=",
      "OK-ACCESS-TIMESTAMP": "2026-10-17T12:00:00.000Z",
      "OK-ACCESS-PASSPHRASE": "fake-passphrase",
      "x-simulated-trading": "1",
    });
    const live = new CaaClient({ creds: CREDS, demo: false, clock }).buildRequest(0);
    expect(live.headers["x-simulated-trading"]).toBeUndefined();
    expect(live.body).toBe('{"timeOut":"0"}');
  });

  it("set() POST eder ve OKX kodu 0 değilse fırlatır; hata metni kimlik bilgisi içermez", async () => {
    const clock = new TestClock();
    const calls: { url: string; method: string; body: string }[] = [];
    const ok: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method), body: String(init?.body) });
      return new Response(JSON.stringify({ code: "0", data: [] }), { status: 200 });
    };
    await new CaaClient({ creds: CREDS, demo: true, clock, fetchImpl: ok }).set(60);
    expect(calls[0]).toMatchObject({ url: "https://tr.okx.com/api/v5/trade/cancel-all-after", method: "POST", body: '{"timeOut":"60"}' });

    const bad: typeof fetch = async () => new Response(JSON.stringify({ code: "50111", msg: "Invalid OK-ACCESS-KEY" }), { status: 200 });
    const err = await new CaaClient({ creds: CREDS, demo: true, clock, fetchImpl: bad }).set(60).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(CREDS.secretKey);
    expect((err as Error).message).not.toContain(CREDS.passphrase);
    const http500: typeof fetch = async () => new Response("x", { status: 500 });
    await expect(new CaaClient({ creds: CREDS, demo: true, clock, fetchImpl: http500 }).set(60)).rejects.toThrow(/HTTP 500/);
  });
});

describe("CAA döngüsü", () => {
  it("yalnız NORMAL iken yeniler; NORMAL değilse yenileme durur; başarısız yenileme aktifliği düşürür; kapanışta timeOut 0", async () => {
    const clock = new TestClock();
    const sets: number[] = [];
    let normal = true;
    let fail = false;
    const loop = new CaaLoop({
      client: {
        set: async (n: number) => {
          if (fail) throw new Error("ağ");
          sets.push(n);
        },
      },
      clock,
      logger: new MemoryLogger(clock),
      isNormal: async () => normal,
    });
    expect(loop.isActive()).toBe(false);
    expect(await loop.tick()).toBe(true);
    expect(loop.isActive()).toBe(true);
    expect(loop.lastRenewAt()).toBe(clock.ms);
    normal = false;
    clock.advance(20_000);
    expect(await loop.tick()).toBe(false);
    expect(sets).toEqual([60]);
    clock.advance(30_000); // son başarılı yenilemeden 50 sn
    expect(loop.isActive()).toBe(false);
    normal = true;
    fail = true;
    expect(await loop.tick()).toBe(false);
    expect(loop.isActive()).toBe(false);
    fail = false;
    expect(await loop.tick()).toBe(true);
    expect(loop.isActive()).toBe(true);
    await loop.stop();
    expect(sets.at(-1)).toBe(0);
    expect(loop.isActive()).toBe(false);
    expect(await loop.tick()).toBe(false); // durdurulduktan sonra yenileme yok
  });
});
