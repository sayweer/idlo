/**
 * M-1 (OKX tarafı): salt-okunur istemci yalnız izin listesindeki GET yollarına, yalnız tr.okx.com'a imzalı istek
 * gönderir; trade/withdraw yetkili anahtarla çalışmaz; anahtar hata mesajlarına girmez.
 */
import { describe, expect, it } from "vitest";
import {
  loadReadonlyCreds,
  OKX_MAX_PAGES,
  OKX_PAGE_LIMIT,
  OKX_READONLY_GET_PATHS,
  OkxError,
  OkxReadonlyClient,
  signOkx,
  type OkxReadonlyPath,
} from "../lib/okx-readonly.js";
import { okxHandler, order, routerFetch } from "./helpers.js";

const CREDS = { apiKey: "rk-test-key-123", secret: "test-secret", passphrase: "pass-phrase-xyz" };
const NOW = new Date("2026-10-17T10:00:00.000Z");

function client(o: Partial<Parameters<typeof okxHandler>[0]> = {}, demo = false) {
  const okx = okxHandler({ ...CREDS, ...o });
  const r = routerFetch({ okx });
  return { c: new OkxReadonlyClient(CREDS, { fetch: r.fetch, demo, now: () => NOW }), okx, seen: r.seen };
}

describe("M-1 OKX salt-okunur istemci (§14)", () => {
  it("M-1 imza OKX v5 biçiminde: base64(HMAC_SHA256(secret, ts + GET + yol?sorgu)) — bağımsız test vektörü", () => {
    expect(
      signOkx(CREDS.secret, "2026-10-17T10:00:00.000Z", "GET", "/api/v5/trade/orders-history?instType=SPOT&instId=USDT-TRY&limit=100"),
    ).toBe("4gLxtrlL3bIltZtCGn76odn+8ZhKn8wLYVIjk4DvRS8=");
  });

  it("M-1 istek: yalnız GET, yalnız https://tr.okx.com, dört OKX başlığı, yönlendirme izlenmez; secret gönderilmez", async () => {
    const seenInit: RequestInit[] = [];
    const okx = okxHandler(CREDS);
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      seenInit.push(init ?? {});
      return okx.handle(new URL(String(input)), init);
    }) as typeof fetch;
    const c = new OkxReadonlyClient(CREDS, { fetch: f, now: () => NOW });
    await c.assertReadOnly();
    expect(seenInit).toHaveLength(1);
    expect(seenInit[0]!.method).toBe("GET");
    expect(seenInit[0]!.redirect).toBe("error");
    expect(seenInit[0]!.body).toBeUndefined();
    const h = new Headers(seenInit[0]!.headers);
    expect(h.get("ok-access-key")).toBe(CREDS.apiKey);
    expect(h.get("ok-access-passphrase")).toBe(CREDS.passphrase);
    expect(h.get("ok-access-timestamp")).toBe("2026-10-17T10:00:00.000Z");
    expect(h.get("ok-access-sign")).toBe(signOkx(CREDS.secret, "2026-10-17T10:00:00.000Z", "GET", "/api/v5/account/config"));
    expect(h.get("x-simulated-trading")).toBeNull();
    expect(JSON.stringify([...h.entries()])).not.toContain(CREDS.secret);
  });

  it("M-1 --demo: x-simulated-trading: 1 başlığı eklenir", async () => {
    const { c, seen } = client({}, true);
    await c.assertReadOnly();
    expect(seen[0]!.headers["x-simulated-trading"]).toBe("1");
  });

  it("M-1 izin listesi: yalnız dört GET yolu; liste dışı yol ya da sorgu alanı ağa hiç gitmez", async () => {
    expect([...OKX_READONLY_GET_PATHS].sort()).toEqual([
      "/api/v5/account/config",
      "/api/v5/trade/orders-history",
      "/api/v5/trade/orders-history-archive",
      "/api/v5/trade/orders-pending",
    ]);
    for (const p of OKX_READONLY_GET_PATHS) expect(p).not.toMatch(/order$|cancel|withdraw|transfer|amend|place|batch/);
    const { c, seen } = client();
    for (const bad of ["/api/v5/trade/order", "/api/v5/trade/cancel-all-after", "/api/v5/asset/withdrawal", "/api/v5/trade/orders-pending/../order"]) {
      await expect(c.get(bad as OkxReadonlyPath)).rejects.toBeInstanceOf(OkxError);
    }
    await expect(c.get("/api/v5/trade/orders-pending", { side: "buy" })).rejects.toThrow(/sorgu alanı/);
    await expect(c.get("/api/v5/trade/orders-pending", { instId: "USDT-TRY&x=1" })).rejects.toThrow(/sorgu değeri/);
    expect(seen).toHaveLength(0);
    // İstemcide emir/iptal/çekim yöntemi yoktur.
    const methods = Object.getOwnPropertyNames(OkxReadonlyClient.prototype).sort();
    expect(methods).toEqual(["assertReadOnly", "constructor", "get", "listOrders", "paginate"]);
  });

  it.each([
    ["read_only", true],
    ["read_only,trade", false],
    ["read_only,withdraw", false],
    ["read_only,withdraw,trade", false],
    ["", false],
  ])("M-1 yetki denetimi: perm=%s → çalışır mı: %s", async (perm, ok) => {
    const { c } = client({ perm });
    if (ok) await expect(c.assertReadOnly()).resolves.toBeUndefined();
    else await expect(c.assertReadOnly()).rejects.toThrow(/salt-okunur değil/);
  });

  it("M-1 emirler: açık + geçmiş, sayfalama after=ordId, aynı ordId bir kez; 7 günden uzun pencere arşivden", async () => {
    const begin = NOW.getTime() - 7 * 86_400_000;
    const hist = Array.from({ length: OKX_PAGE_LIMIT + 5 }, (_, i) => order({ ordId: String(9000 - i), cTime: String(begin + 1000 + i) }));
    const open = order({ ordId: "9000", cTime: String(begin + 1000), state: "live" });
    const { c, okx } = client({ history: hist, pending: [open] });
    const rows = await c.listOrders({ beginMs: begin, endMs: NOW.getTime(), days: 7 });
    expect(rows).toHaveLength(OKX_PAGE_LIMIT + 5);
    expect(rows.find((r) => r.ordId === "9000")!.state).toBe("live");
    const histCalls = okx.calls.filter((x) => x.path === "/api/v5/trade/orders-history");
    expect(histCalls).toHaveLength(2);
    expect(histCalls[0]!.query).toEqual({ instType: "SPOT", instId: "USDT-TRY", begin: String(begin), end: String(NOW.getTime()), limit: "100" });
    expect(histCalls[1]!.query.after).toBe(hist[OKX_PAGE_LIMIT - 1]!.ordId);

    const arch = client({ archive: [order({ ordId: "1", cTime: String(begin) })] });
    await arch.c.listOrders({ beginMs: begin - 86_400_000, endMs: NOW.getTime(), days: 8 });
    expect(arch.okx.calls.map((x) => x.path)).toContain("/api/v5/trade/orders-history-archive");
    expect(arch.okx.calls.map((x) => x.path)).not.toContain("/api/v5/trade/orders-history");
  });

  it("M-1 sayfa sınırı aşılırsa hata (sessizce eksik sonuç yok)", async () => {
    const many = Array.from({ length: OKX_PAGE_LIMIT * OKX_MAX_PAGES }, (_, i) => order({ ordId: String(1_000_000 - i), cTime: "1" }));
    const { c } = client({ pending: many });
    await expect(c.listOrders({ beginMs: 0, endMs: 1, days: 1 })).rejects.toThrow(/çok fazla emir/);
  });

  it("M-1 hatalar fail-closed; mesajda anahtar, secret ya da passphrase geçmez", async () => {
    const cases = [
      client({ failCode: "50113" }).c,
      new OkxReadonlyClient({ ...CREDS, secret: "yanlis" }, { fetch: routerFetch({ okx: okxHandler(CREDS) }).fetch, now: () => NOW }),
      new OkxReadonlyClient(CREDS, { fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch }),
      new OkxReadonlyClient(CREDS, { fetch: (async () => { throw new Error(`bağlantı ${CREDS.apiKey}`); }) as unknown as typeof fetch }),
      new OkxReadonlyClient(CREDS, {
        fetch: (async () => Response.json({ code: "0", msg: "", data: [{ ordId: "x" }] })) as unknown as typeof fetch,
      }),
    ];
    for (const c of cases) {
      const err = await c.listOrders({ beginMs: 0, endMs: 1, days: 1 }).then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(OkxError);
      for (const s of [CREDS.apiKey, CREDS.secret, CREDS.passphrase]) expect(err!.message).not.toContain(s);
    }
  });

  it("M-1 ortam: üç OKX_READONLY_* alanı zorunlu; değer mesajda geçmez", () => {
    expect(loadReadonlyCreds({ OKX_READONLY_API_KEY: "a", OKX_READONLY_SECRET: "b", OKX_READONLY_PASSPHRASE: "c" })).toEqual({
      apiKey: "a",
      secret: "b",
      passphrase: "c",
    });
    expect(() => loadReadonlyCreds({ OKX_READONLY_API_KEY: "gizli-deger", OKX_READONLY_SECRET: "b" })).toThrow(/OKX_READONLY_PASSPHRASE/);
    try {
      loadReadonlyCreds({ OKX_READONLY_API_KEY: "gizli\ndeger", OKX_READONLY_SECRET: "b", OKX_READONLY_PASSPHRASE: "c" });
    } catch (e) {
      expect((e as Error).message).not.toContain("gizli");
    }
    // KULE'nin trade anahtarı adları okunmaz.
    expect(() => loadReadonlyCreds({ OKX_API_KEY: "a", OKX_SECRET_KEY: "b", OKX_PASSPHRASE: "c" })).toThrow(OkxError);
  });
});
