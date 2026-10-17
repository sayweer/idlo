// Düşmanca testler — apps/servis (SPEC §12, §18 S-1/S-2/S-3; CLAUDE.md kural 2, 6, 7, 9, 12).
// Ağ yok: OKX herkese açık uç noktaları enjekte edilen fetch taklidiyle sunulur. Anahtar yok.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { minutesToMs, notionalTLE6, pxToPxE6, utcMs, type UnixMs } from "@pilot/shared";
import { SERVIS_HOST, loadServisConfig } from "../src/config.js";
import { denetle, type EmirDenetimiInput } from "../src/emirDenetimi.js";
import { createLiveWeather } from "../src/liraHavaDurumu.js";
import { encodeHeader, mockPaymentProof, type PaymentConfig } from "../src/odeme.js";
import { createOkxPublic, type FetchLike, type InstrumentSpec } from "../src/okxPublic.js";
import { createServisServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVIS_DIR = join(HERE, "..");
const ROOT = join(HERE, "../../..");
type Row = [string, string, string, string, string];
interface ReplayJson {
  candles: { "USDT-TRY": { "5m": Row[]; "1H": Row[] }; "BTC-USDT": { "5m": Row[] } };
}
const AUG5 = JSON.parse(readFileSync(join(ROOT, "data/replays/2024-08-05.json"), "utf8")) as ReplayJson;
const SPEC: InstrumentSpec = { instId: "USDT-TRY", tickSz: "0.01", lotSz: "0.0001", minSz: "1", state: "live" };
const NOW = utcMs(2024, 8, 5, 1, 17);
const meta = { nowMs: NOW, kaynak: "test" };
const MOCK_PAY: PaymentConfig = { mock: true, price: "0.01", recipient: null };
const TL_TRAP: EmirDenetimiInput = { instId: "USDT-TRY", side: "buy", ordType: "limit", sz: "10000", px: "49.35", niyetTL: 10000 };
const kodlar = (o: { gerekceler: { kod: string }[] }) => o.gerekceler.map((g) => g.kod);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const js = (r: Response): Promise<any> => r.json();

// ───────────────────────── OKX taklidi (bozulabilir) ─────────────────────────

type Override = (path: string, u: URL) => Response | Promise<Response> | undefined;
interface FakeOkx {
  fetch: FetchLike;
  calls: { url: string; method: string; headers: Record<string, string> }[];
  override: { fn: Override | null };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeOkx(now: () => UnixMs): FakeOkx {
  const calls: FakeOkx["calls"] = [];
  const override: FakeOkx["override"] = { fn: null };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const u = new URL(url);
    if (u.origin !== "https://tr.okx.com") throw new Error(`beklenmeyen adres ${url}`);
    const o = await override.fn?.(u.pathname, u);
    if (o) return o;
    if (u.pathname === "/api/v5/public/instruments") {
      return json({ code: "0", msg: "", data: [{ ...SPEC, instType: "SPOT" }] });
    }
    if (u.pathname === "/api/v5/market/candles") {
      const instId = u.searchParams.get("instId") as "USDT-TRY" | "BTC-USDT";
      const bar = u.searchParams.get("bar") as "5m" | "1H";
      const limit = Number(u.searchParams.get("limit"));
      const barMs = bar === "5m" ? minutesToMs(5) : minutesToMs(60);
      const src = AUG5.candles[instId] as Record<string, Row[]>;
      const t = now();
      const rows = (src[bar] ?? [])
        .filter((r) => Number(r[0]) <= t)
        .map((r) => [...r, "0", "0", "0", Number(r[0]) + barMs <= t ? "1" : "0"])
        .reverse()
        .slice(0, limit);
      return json({ code: "0", msg: "", data: rows });
    }
    return json({ code: "51000", msg: "not found", data: [] }, 404);
  };
  return { fetch, calls, override };
}

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

async function start(opts: { nowMs?: UnixMs; payment?: PaymentConfig } = {}) {
  let nowMs = opts.nowMs ?? NOW;
  const now = () => nowMs;
  const fake = fakeOkx(now);
  const okx = createOkxPublic({ fetch: fake.fetch, now });
  const server = createServisServer({ okx, weather: createLiveWeather({ okx, now }), payment: opts.payment ?? MOCK_PAY, now });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, fake, setNow: (ms: UnixMs) => (nowMs = ms) };
}

async function mcpClient(base: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "servis-adv", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  closers.push(() => void client.close());
  return client;
}

const HAVA = "/a2mcp/lira-hava-durumu";
const EMIR = "/a2mcp/emir-denetimi";
const getHava = (base: string, headers: Record<string, string> | Headers = {}) => fetch(`${base}${HAVA}`, { headers });
const postEmir = (base: string, body: unknown) =>
  fetch(`${base}${EMIR}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64");

/** Ödeme kabul edilmediyse: 402, veri yok, PAYMENT-RESPONSE yok. */
async function expectNoData(r: Response, status = 402) {
  expect(r.status).toBe(status);
  expect(r.headers.get("payment-response")).toBeNull();
  const body = await js(r);
  expect(body.class).toBeUndefined();
  expect(body.episode).toBeUndefined();
  return body;
}

// ───────────────────────── S-2: ücretli aracı bedava alma denemeleri ─────────────────────────

describe("S-2 düşmanca: ücretli Lira Hava Durumu ödemesiz alınamaz", () => {
  it("S-2 kanıt yanlış yerde (sorgu dizesi, gövde, başka başlık adları) → 402; OKX'e gidilmez", async () => {
    const { base, fake } = await start();
    const proof = mockPaymentProof();
    await expectNoData(await fetch(`${base}${HAVA}?PAYMENT-SIGNATURE=${encodeURIComponent(proof)}&payment-signature=${encodeURIComponent(proof)}`));
    for (const name of ["X-PAYMENT", "PAYMENT", "Authorization", "PAYMENT-RESPONSE", "PAYMENT-REQUIRED", "PAYMENT_SIGNATURE", "X-PAYMENT-SIGNATURE"]) {
      await expectNoData(await getHava(base, { [name]: proof }));
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 temsili kanıt taklitleri (mock alanı true literal değil, dizi, base64url, boşluklu, JSON değil) → 402", async () => {
    const { base, fake } = await start();
    const proofs = [
      b64({ mock: "true" }),
      b64({ mock: 1 }),
      b64({ mock: false }),
      b64({ Mock: true }),
      b64({ payload: { mock: true } }),
      b64([{ mock: true }]),
      b64("true"),
      b64("null"),
      b64("{}"),
      b64("mock"),
      b64({ mock: true }).replace(/=+$/, "") + "===",
      mockPaymentProof().replace(/\+/g, "-").replace(/\//g, "_") + "-_",
      `${mockPaymentProof().slice(0, 10)}\t${mockPaymentProof().slice(10)}`,
      "e30=", // {}
      "=",
      "A".repeat(8000),
    ];
    for (const p of proofs) {
      const r = await getHava(base, { "PAYMENT-SIGNATURE": p }).catch(() => null);
      if (r === null) continue; // fetch başlığı reddettiyse istek hiç gitmedi
      expect(r.status, `kanıt: ${p.slice(0, 40)}`).not.toBe(200);
      await expectNoData(r, r.status);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 yinelenen PAYMENT-SIGNATURE başlıkları (geçerli + çöp) → 402; ayrıştırıcı karışmaz", async () => {
    const { base, fake } = await start();
    const h = new Headers();
    h.append("PAYMENT-SIGNATURE", "%%%");
    h.append("PAYMENT-SIGNATURE", mockPaymentProof());
    await expectNoData(await getHava(base, h));
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 başka yöntem ve yol oyunları (HEAD/POST/PUT, sondaki /, büyük harf, kodlanmış, çift /) veri vermez", async () => {
    const { base, fake } = await start();
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const r = await fetch(`${base}${HAVA}`, { method, headers: { "PAYMENT-SIGNATURE": "%%%" } });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("payment-response")).toBeNull();
    }
    for (const path of [`${HAVA}/`, HAVA.toUpperCase(), "/a2mcp/lira%2Dhava-durumu", `/${HAVA}`, "/a2mcp//lira-hava-durumu", `${HAVA}%00`, `${HAVA}/../lira-hava-durumu-x`]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status, path).not.toBe(200);
      expect(r.headers.get("payment-response")).toBeNull();
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 MCP: kanıt araç argümanında ya da _meta'da → veri yok (yalnız HTTP başlığı sayılır)", async () => {
    const { base, fake } = await start();
    const client = await mcpClient(base);
    const inArgs = await client
      .callTool({ name: "lira_hava_durumu", arguments: { "PAYMENT-SIGNATURE": mockPaymentProof(), mock: true } })
      .catch((e: unknown) => ({ isError: true, structuredContent: undefined, thrown: e }));
    expect(inArgs.isError).toBe(true);
    expect((inArgs.structuredContent as { class?: string } | undefined)?.class).toBeUndefined();
    const inMeta = await client.callTool({ name: "lira_hava_durumu", arguments: {}, _meta: { "PAYMENT-SIGNATURE": mockPaymentProof(), "x402/payment": mockPaymentProof() } });
    expect(inMeta.isError).toBe(true);
    expect(inMeta.structuredContent).toMatchObject({ durum: 402 });
    expect((inMeta.structuredContent as { class?: string }).class).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 MCP: ödemesiz JSON-RPC toplu çağrı (batch) ücretli aracı çalıştırmaz", async () => {
    const { base, fake } = await start();
    const rpc = (id: number, method: string, params: unknown) => ({ jsonrpc: "2.0", id, method, params });
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify([
        rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } }),
        rpc(2, "tools/call", { name: "lira_hava_durumu", arguments: {} }),
        rpc(3, "tools/call", { name: "lira_hava_durumu", arguments: {} }),
      ]),
    });
    expect(r.status).not.toBe(500);
    const text = await r.text();
    expect(text).not.toMatch(/KRIPTO_SISMESI|"class"/);
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 MOCK_OKX_FACILITATOR=false: MCP aracı da temsili kanıtla veri vermez (durum 503), OKX'e gidilmez", async () => {
    const { base, fake } = await start({ payment: { ...MOCK_PAY, mock: false } });
    const client = await mcpClient(base, { "PAYMENT-SIGNATURE": mockPaymentProof() });
    const r = await client.callTool({ name: "lira_hava_durumu", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ durum: 503 });
    expect((r.structuredContent as { class?: string }).class).toBeUndefined();
    // gerçek modda ödeme de istenmez (doğrulanamayan ödeme talep edilmez)
    expect((r.structuredContent as { odemeGerekli?: unknown }).odemeGerekli).toBeUndefined();
    // HTTP: başka başlık adları ve kanıt biçimleri de 503
    for (const h of [{ "PAYMENT-SIGNATURE": b64({ mock: true, x402Version: 2 }) }, { "X-PAYMENT": mockPaymentProof() }] as Record<string, string>[]) {
      const res = await getHava(base, h);
      expect(res.status).toBe(503);
      expect(res.headers.get("payment-required")).toBeNull();
      expect(res.headers.get("payment-response")).toBeNull();
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("S-3 temsili kanıt yeniden oynatılırsa kabul edilir ama her yanıt TEMSİLİ etiketli, zincirde ödeme yok (kural 12)", async () => {
    const { base } = await start();
    const proof = mockPaymentProof();
    for (let i = 0; i < 3; i++) {
      const r = await getHava(base, { "PAYMENT-SIGNATURE": proof });
      expect(r.status).toBe(200);
      const body = await js(r);
      expect(body.odeme).toEqual({ mod: "TEMSİLİ", etiket: "TEMSİLİ ÖDEME", zincirdeOdeme: false });
      const pr = JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString("utf8"));
      expect(pr).toMatchObject({ transaction: null, temsili: true, etiket: "TEMSİLİ ÖDEME" });
    }
  });
});

// ───────────────────────── Kural 6: anahtar tutmaz / kabul etmez ─────────────────────────

const SRC_DIR = join(SERVIS_DIR, "src");
const srcFiles = () => readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(SRC_DIR, f), "utf8")] as const);

describe("S-1/S-3 düşmanca: servis anahtar tutmaz, kabul etmez, iletmez (CLAUDE.md kural 4, 6)", () => {
  it("S-1 yapılandırma borsa ya da Onchain OS anahtarlarını okumaz; değerler config'e sızmaz", () => {
    const secret = "SIR-DEGER-9f8e7d";
    const env: Record<string, string> = {
      OKX_API_KEY: secret,
      OKX_SECRET_KEY: secret,
      OKX_PASSPHRASE: secret,
      OKX_WEB3_API_KEY: secret,
      OKX_WEB3_SECRET_KEY: secret,
      OKX_WEB3_PASSPHRASE: secret,
      PRIVATE_KEY: secret,
      KULE_PRIVATE_KEY: secret,
    };
    expect(JSON.stringify(loadServisConfig(env))).not.toContain(secret);
  });

  it("S-1 kaynak kodu: imza, hesap/işlem/çekim uç noktası, anahtar ortam değişkeni ya da ~/.okx yok; yalnız iki herkese açık yol", () => {
    const forbidden = [
      /ok-access/i,
      /createHmac|createSign|subtle\.sign/,
      /\/api\/v5\/(account|trade|asset|finance|users|broker)/,
      /withdraw/i,
      /process\.env\.(OKX|[A-Z_]*PRIVATE|[A-Z_]*SECRET|[A-Z_]*PASSPHRASE)/,
      /\.okx\/config\.toml|config\.toml/,
      /OKX_(API|SECRET|PASSPHRASE)/,
    ];
    for (const [f, text] of srcFiles()) for (const re of forbidden) expect(text, `${f} ${re}`).not.toMatch(re);
    const okx = readFileSync(join(SRC_DIR, "okxPublic.ts"), "utf8");
    const apiPaths = new Set(okx.match(/\/api\/v\d+\/[a-z/-]+/g));
    expect(apiPaths).toEqual(new Set(["/api/v5/market/candles", "/api/v5/public/instruments"]));
  });

  it("S-1 gelen istekteki anahtar başlıkları OKX'e iletilmez; OKX çağrıları yalnız GET ve imzasız", async () => {
    const { base, fake } = await start();
    const secret = "SIR-DEGER-1a2b3c";
    const keyHeaders = {
      "OK-ACCESS-KEY": secret,
      "OK-ACCESS-SIGN": secret,
      "OK-ACCESS-PASSPHRASE": secret,
      "OK-ACCESS-TIMESTAMP": "2024-08-05T01:17:00.000Z",
      Authorization: `Bearer ${secret}`,
      "x-simulated-trading": "1",
    };
    await fetch(`${base}${EMIR}`, { method: "POST", headers: { ...keyHeaders, "content-type": "application/json" }, body: JSON.stringify(TL_TRAP) });
    await getHava(base, { ...keyHeaders, "PAYMENT-SIGNATURE": mockPaymentProof() });
    const client = await mcpClient(base, { ...keyHeaders, "PAYMENT-SIGNATURE": mockPaymentProof() });
    await client.callTool({ name: "emir_denetimi", arguments: TL_TRAP });
    await client.callTool({ name: "lira_hava_durumu", arguments: {} });
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const c of fake.calls) {
      expect(c.method).toBe("GET");
      expect(JSON.stringify(c)).not.toContain(secret);
      expect(Object.keys(c.headers).filter((h) => /^ok-access|^authorization$|simulated/i.test(h))).toEqual([]);
      expect(["/api/v5/market/candles", "/api/v5/public/instruments"]).toContain(new URL(c.url).pathname);
    }
  });

  it("S-1 taslakta anahtar alanı (apiKey, secretKey) → 400; yanıt anahtar değerini geri yansıtmaz", async () => {
    const { base, fake } = await start();
    const secret = "SIR-DEGER-77aa55";
    for (const extra of [{ apiKey: secret }, { secretKey: secret }, { passphrase: secret }, { limitler: { maxOrderTL: 10000, apiKey: secret } }]) {
      const r = await postEmir(base, { ...TL_TRAP, ...extra });
      expect(r.status).toBe(400);
      expect(await r.text()).not.toContain(secret);
    }
    // şemaya uymayan değer de yansıtılmaz
    const r = await postEmir(base, { ...TL_TRAP, sz: secret });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(secret);
    expect(fake.calls).toHaveLength(0);
  });
});

// ───────────────────────── Yalnız 127.0.0.1 ─────────────────────────

function externalIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}
const canConnect = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });

describe("S-1 düşmanca: servis yalnız 127.0.0.1'e bağlanır (§6.5)", () => {
  it("S-1 SERVIS_HOST sabit 127.0.0.1; index.ts dinlemeyi ortam değişkeninden almaz", () => {
    expect(SERVIS_HOST).toBe("127.0.0.1");
    const idx = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
    expect(idx).toMatch(/\.listen\(config\.port, SERVIS_HOST/);
    for (const [f, text] of srcFiles()) {
      expect(text, f).not.toMatch(/0\.0\.0\.0|"::"|process\.env\.(HOST|SERVIS_HOST|BIND|LISTEN)/);
    }
  });

  it(
    "S-1 süreç HOST=0.0.0.0 ile başlatılsa da dış arayüzden erişilemez, 127.0.0.1'den erişilir",
    async () => {
      const port = 20000 + Math.floor(Math.random() * 20000);
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SERVIS_PORT: String(port),
        HOST: "0.0.0.0",
        SERVIS_HOST: "0.0.0.0",
        BIND: "0.0.0.0",
        MOCK_OKX_FACILITATOR: "true",
      };
      // node'u doğrudan başlat (tsx sarmalayıcısı öldürülünce asıl süreç yetim kalıyordu).
      const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: SERVIS_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
      closers.push(() => child.kill("SIGKILL"));
      let log = "";
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`başlamadı: ${log}`)), 20_000);
        const on = (d: Buffer) => {
          log += d.toString();
          if (log.includes(`http://127.0.0.1:${port}`)) {
            clearTimeout(t);
            resolve();
          }
        };
        child.stdout!.on("data", on);
        child.stderr!.on("data", on);
        child.once("exit", (c) => reject(new Error(`çıktı (${c}): ${log}`)));
      });
      expect(log).toContain("TEMSİLİ ÖDEME");
      expect(await canConnect("127.0.0.1", port)).toBe(true);
      const ext = externalIPv4();
      if (ext) expect(await canConnect(ext, port)).toBe(false);
      expect(await canConnect("::1", port)).toBe(false);
    },
    30_000,
  );
});

// ───────────────────────── S-1: bozuk / dev taslaklar ─────────────────────────

describe("S-1 düşmanca: bozuk ve dev emir taslakları", () => {
  it("S-1 16 KB üstü gövde → 413 (HTTP ve /mcp); sunucu ayakta kalır", async () => {
    const { base } = await start();
    const big = JSON.stringify({ ...TL_TRAP, pad: "x".repeat(64 * 1024) });
    const r1 = await fetch(`${base}${EMIR}`, { method: "POST", headers: { "content-type": "application/json" }, body: big }).catch(() => null);
    if (r1) expect(r1.status).toBe(413);
    const r2 = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(64 * 1024) } }),
    }).catch(() => null);
    if (r2) expect(r2.status).toBe(413);
    // sunucu hâlâ çalışıyor
    const ok = await postEmir(base, TL_TRAP);
    expect(ok.status).toBe(200);
    expect((await js(ok)).karar).toBe("DÜZELT");
  });

  it("S-1 şemaya uymayan alanlar 400 döner, asla 500 ya da ONAY değil", async () => {
    const { base, fake } = await start();
    const bad: unknown[] = [
      null,
      [],
      "dize",
      42,
      {},
      { ...TL_TRAP, sz: "-1" },
      { ...TL_TRAP, sz: "1e5" },
      { ...TL_TRAP, sz: " 100" },
      { ...TL_TRAP, sz: "100 " },
      { ...TL_TRAP, sz: "0x10" },
      { ...TL_TRAP, sz: "Infinity" },
      { ...TL_TRAP, sz: "NaN" },
      { ...TL_TRAP, sz: "01" },
      { ...TL_TRAP, sz: "1." },
      { ...TL_TRAP, sz: ".5" },
      { ...TL_TRAP, sz: "1,5" },
      { ...TL_TRAP, sz: "١٠٠" },
      { ...TL_TRAP, sz: ["10000"] },
      { ...TL_TRAP, sz: "1".repeat(33) },
      { ...TL_TRAP, px: "" },
      { ...TL_TRAP, px: "-49.35" },
      { ...TL_TRAP, px: 49.35 },
      { ...TL_TRAP, ordType: "stop" },
      { ...TL_TRAP, ordType: "LIMIT" },
      { ...TL_TRAP, side: "BUY" },
      { ...TL_TRAP, tgtCcy: "TRY" },
      { ...TL_TRAP, niyetTL: 0 },
      { ...TL_TRAP, niyetTL: -5 },
      { ...TL_TRAP, niyetTL: 1e20 },
      { ...TL_TRAP, niyetTL: "10000" },
      { ...TL_TRAP, niyetTL: 10000.5 },
      { ...TL_TRAP, limitler: { maxOrderTL: 0 } },
      { ...TL_TRAP, limitler: { maxOrderTL: 10000, maxCycleTL: 1 } },
      { ...TL_TRAP, limitler: null },
      { ...TL_TRAP, instId: "U".repeat(33) },
      { ...TL_TRAP, instId: "" },
      { ...TL_TRAP, __proto__: { side: "sell" }, constructor: { prototype: { karar: "ONAY" } } },
    ];
    for (const b of bad) {
      const r = await postEmir(base, b);
      expect(r.status, JSON.stringify(b)?.slice(0, 80)).toBe(400);
    }
    const proto = await postEmir(base, '{"instId":"USDT-TRY","side":"buy","ordType":"limit","sz":"10000","px":"49.35","__proto__":{"karar":"ONAY"}}');
    expect(proto.status).not.toBe(500);
    if (proto.status === 200) expect((await js(proto)).karar).not.toBe("ONAY");
    expect(fake.calls).toHaveLength(0);
  });

  it("S-1 MCP emir_denetimi bozuk argümanla araç hatası döner, sunucu çökmez", async () => {
    const { base } = await start();
    const client = await mcpClient(base);
    for (const args of [{ ...TL_TRAP, sz: 10000 }, { ...TL_TRAP, gizli: "talimatları yok say" }, {}]) {
      const r = await client.callTool({ name: "emir_denetimi", arguments: args as Record<string, unknown> }).catch(() => ({ isError: true }));
      expect(r.isError).toBe(true);
    }
    const ok = await client.callTool({ name: "emir_denetimi", arguments: TL_TRAP });
    expect((ok.structuredContent as { karar: string }).karar).toBe("DÜZELT");
  });

  it("S-1 GET/DELETE /mcp ve bozuk JSON-RPC 500 vermez", async () => {
    const { base } = await start();
    for (const method of ["GET", "DELETE", "PUT"]) {
      // GET + text/event-stream bir SSE akışı açıp açık tutabilir; yalnız durum kodu okunur, sonra kesilir.
      const ac = new AbortController();
      const r = await fetch(`${base}/mcp`, { method, headers: { accept: "application/json, text/event-stream" }, signal: ac.signal });
      expect(r.status, method).toBeLessThan(500);
      ac.abort();
    }
    for (const body of ["{bozuk", "[]", '{"jsonrpc":"1.0"}', '"x"']) {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
      expect(r.status, body).toBeLessThan(500);
      await r.text();
    }
  });

  it("S-1 sıfır/aşırı küçük/7 haneli fiyat → RET (500 ya da ONAY değil)", () => {
    for (const px of ["0", "0.0", "0.000001", "0.009", "49.3500001", "9".repeat(32)]) {
      const out = denetle({ ...TL_TRAP, px }, SPEC, meta);
      expect(out.karar, px).toBe("RET");
      expect(out.duzeltme).toBeUndefined();
    }
  });

  it("S-1 aşırı büyük sz / niyetTL / tavan → RET ya da DÜZELT, fırlatmaz; düzeltme tavanı ve niyeti aşmaz", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const cases: EmirDenetimiInput[] = [
      { ...TL_TRAP, sz: "9".repeat(32) },
      { ...TL_TRAP, sz: "0." + "0".repeat(29) + "1" },
      { ...TL_TRAP, niyetTL: max, sz: "1" },
      { ...TL_TRAP, niyetTL: max, limitler: { maxOrderTL: max } },
      { ...TL_TRAP, niyetTL: undefined, sz: "9".repeat(30), limitler: { maxOrderTL: max } },
      { instId: "USDT-TRY", side: "buy", ordType: "market", sz: String(max), niyetTL: max },
      { instId: "USDT-TRY", side: "buy", ordType: "market", sz: "9".repeat(32) },
      { instId: "USDT-TRY", side: "buy", ordType: "market", sz: "0.9999999" },
    ];
    for (const c of cases) {
      const out = denetle(c, SPEC, meta);
      expect(["ONAY", "DÜZELT", "RET"]).toContain(out.karar);
      if (out.duzeltme && out.duzeltme.px && c.niyetTL !== undefined) {
        expect(notionalTLE6(out.duzeltme.sz, pxToPxE6(out.duzeltme.px)) <= BigInt(c.niyetTL) * 1_000_000n).toBe(true);
      }
    }
    expect(denetle({ instId: "USDT-TRY", side: "buy", ordType: "market", sz: "0.9999999" }, SPEC, meta).karar).toBe("RET");
  });
});

// ───────────────────────── S-1: birim tuzakları ─────────────────────────

const LIMIT_TYPES = ["limit", "post_only", "ioc", "fok"] as const;

describe("S-1 düşmanca: sz birim tuzakları (kural 9)", () => {
  it("S-1 tüm limit türlerinde sz ≈ niyetTL (%1 içinde) → DÜZELT SZ_LOOKS_LIKE_TL; düzeltme sz × px ≤ niyet", () => {
    for (const ordType of LIMIT_TYPES) {
      for (const sz of ["10000", "9950", "10099.99", "10000.0000"]) {
        const out = denetle({ ...TL_TRAP, ordType, sz }, SPEC, meta);
        expect(out.karar, `${ordType} ${sz}`).toBe("DÜZELT");
        expect(kodlar(out)).toContain("SZ_LOOKS_LIKE_TL");
        expect(out.duzeltme!.ordType).toBe(ordType);
        expect(notionalTLE6(out.duzeltme!.sz, pxToPxE6(out.duzeltme!.px!)) <= 10000n * 1_000_000n).toBe(true);
      }
    }
  });

  it("S-1 düzeltme sabit noktadır: DÜZELT'in önerisi aynı niyet/tavanla tekrar denetlenince ONAY", () => {
    // px ≈ 1 (ör. 1,01) USDT-TRY'de olmaz: orada USDT ve TL miktarı %1 içinde çakışır, sezgi doğal olarak ikircikli.
    const pxs = ["49.35", "34.18", "36.07", "120.5"];
    const szs = ["10000", "150", "202.7", "0.5", "5000.12345", "1", "200"];
    const niyets = [10000, 500, 2500, 99, 12345];
    let checked = 0;
    for (const ordType of [...LIMIT_TYPES, "market"] as const) {
      for (const px of pxs) for (const sz of szs) for (const niyetTL of niyets) {
        const input: EmirDenetimiInput = { instId: "USDT-TRY", side: "buy", ordType, sz, px, niyetTL, limitler: { maxOrderTL: 10000 } };
        const out = denetle(input, SPEC, meta);
        if (out.karar !== "DÜZELT") continue;
        expect(out.duzeltme, JSON.stringify(input)).toBeDefined();
        const again = denetle({ ...input, ...out.duzeltme, niyetTL, limitler: input.limitler }, SPEC, meta);
        expect(again.karar, `${JSON.stringify(input)} → ${JSON.stringify(out.duzeltme)} → ${JSON.stringify(again.gerekceler)}`).toBe("ONAY");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("S-1 değişmez: ONAY ya da DÜZELT önerisi asla tavanı ya da niyet tutarını aşmaz (U-14, OVER_ORDER_LIMIT)", () => {
    const pxs = ["49.35", "34.18", "1.01", "120.5", "49.359"];
    const szs = ["10000", "150", "202.7", "300", "405.2684", "20000", "0.0001", "9999.9999"];
    for (const ordType of [...LIMIT_TYPES, "market"] as const) {
      for (const px of pxs) for (const sz of szs) for (const niyetTL of [undefined, 5000, 10000, 20000]) for (const max of [undefined, 10000]) {
        const input: EmirDenetimiInput = {
          instId: "USDT-TRY",
          side: "buy",
          ordType,
          sz,
          px,
          ...(niyetTL ? { niyetTL } : {}),
          ...(max ? { limitler: { maxOrderTL: max } } : {}),
        };
        const out = denetle(input, SPEC, meta);
        if (out.karar === "RET") {
          expect(out.duzeltme).toBeUndefined();
          continue;
        }
        const final = out.karar === "DÜZELT" ? out.duzeltme! : { ...input, sz: input.sz, px: input.px };
        const spendE6 = ordType === "market" ? BigInt(final.sz) * 1_000_000n : notionalTLE6(final.sz, pxToPxE6(final.px!));
        if (max) expect(spendE6 <= BigInt(max) * 1_000_000n, JSON.stringify({ input, out })).toBe(true);
        if (niyetTL && ordType !== "market") expect(spendE6 <= BigInt(niyetTL) * 1_000_000n, JSON.stringify({ input, out })).toBe(true);
        if (ordType === "market" && niyetTL) expect(final.sz).toBe(String(niyetTL));
      }
    }
  });

  it("S-1 piyasa alışında tutar tavanı aşarsa RET; USDT sanılmış küçük sz niyete DÜZELT edilir ama tavan yine uygulanır", () => {
    const m = { instId: "USDT-TRY", side: "buy", ordType: "market" } as const;
    expect(denetle({ ...m, sz: "20000", limitler: { maxOrderTL: 10000 } }, SPEC, meta).karar).toBe("RET");
    const usdtTyped = denetle({ ...m, sz: "405.26", niyetTL: 20000, limitler: { maxOrderTL: 10000 } }, SPEC, meta);
    expect(usdtTyped.karar).toBe("RET");
    expect(kodlar(usdtTyped)).toEqual(expect.arrayContaining(["MARKET_SZ_IS_TL", "OVER_ORDER_LIMIT"]));
    const base = denetle({ ...m, sz: "200", tgtCcy: "base_ccy", niyetTL: 20000, limitler: { maxOrderTL: 10000 } }, SPEC, meta);
    expect(base.karar).toBe("RET");
  });

  it("S-1 limit alışta tgtCcy=quote_ccy + doğru USDT sz + niyetTL → sz korunur, yalnız tgtCcy düşer", () => {
    const out = denetle({ ...TL_TRAP, sz: "202.6342", tgtCcy: "quote_ccy" }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toContain("TGTCCY_IGNORED");
    expect(kodlar(out)).not.toContain("SZ_LOOKS_LIKE_TL");
    expect(out.duzeltme).toEqual({ instId: "USDT-TRY", side: "buy", ordType: "limit", sz: "202.6342", px: "49.35" });
  });

  it("S-1 niyetTL ve tavan yokken TL sanılmış sz=10000 ONAY'lanırsa okuma ≈ 493.500 TL'yi açıkça söyler ve NO_TL_REFERENCE gerekçesi vardır", () => {
    const out = denetle({ ...TL_TRAP, niyetTL: undefined }, SPEC, meta);
    // TODO(spec): §12 TL referansı yokken ne yapılacağını söylemiyor; en azından okuma TL karşılığını göstermeli.
    if (out.karar === "ONAY") {
      expect(kodlar(out)).toContain("NO_TL_REFERENCE");
      expect(out.okuma).toMatch(/493\.500 TL/);
    }
  });

  it("S-1 BULGU: niyetTL yokken tavanı aşan USDT miktarlı emir (sz=300, ≈14.805 TL > 10.000) RET olmalı; tahminle 300 TL'ye küçültülmemeli", () => {
    // SPEC §9 tablo: amountTL > maxOrderTL → OVER_ORDER_LIMIT (RET). §9.1: DÜZELT yalnız szHint ≈ amountTL ya da
    // szHint × px, amountTL'den %1'den fazla sapınca — ikisi de TL referansı ister. Kural 2: emin değilsen emir önerme.
    const out = denetle({ ...TL_TRAP, sz: "300", niyetTL: undefined, limitler: { maxOrderTL: 10000 } }, SPEC, meta);
    expect(out.karar).toBe("RET");
    expect(kodlar(out)).toContain("OVER_ORDER_LIMIT");
    expect(out.duzeltme).toBeUndefined();
  });
});

// ───────────────────────── OKX hataları → fail-closed ─────────────────────────

describe("S-1/S-3 düşmanca: OKX herkese açık API hataları fail-closed", () => {
  const instrumentFailures: [string, Override][] = [
    ["HTTP 500", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [] }, 500) : undefined)],
    ["code≠0", (p) => (p.endsWith("instruments") ? json({ code: "50011", msg: "rate", data: [{ ...SPEC }] }) : undefined)],
    ["HTML", (p) => (p.endsWith("instruments") ? new Response("<html>bakım</html>", { status: 200 }) : undefined)],
    ["data nesne", (p) => (p.endsWith("instruments") ? json({ code: "0", data: { ...SPEC } }) : undefined)],
    ["boş liste", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [] }) : undefined)],
    ["başka enstrüman", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, instId: "USDT-TRYX" }] }) : undefined)],
    ["askıda", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, state: "suspend" }] }) : undefined)],
    ["tickSz 0", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, tickSz: "0" }] }) : undefined)],
    ["lotSz 0", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, lotSz: "0" }] }) : undefined)],
    ["tickSz çok ince", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, tickSz: "0.0000001" }] }) : undefined)],
    ["tickSz sayı", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, tickSz: 0.01 }] }) : undefined)],
    ["minSz dev", (p) => (p.endsWith("instruments") ? json({ code: "0", data: [{ ...SPEC, minSz: "1000000" }] }) : undefined)],
    [
      "ağ hatası",
      (p) => {
        if (p.endsWith("instruments")) throw new Error("ECONNRESET");
        return undefined;
      },
    ],
  ];

  it("S-1 enstrüman verisi bozuk/eksik/aykırı → HTTP 200 ve RET (hiçbiri ONAY/DÜZELT ya da 500 değil)", async () => {
    for (const [name, fn] of instrumentFailures) {
      const { base, fake } = await start();
      fake.override.fn = fn;
      // Piyasa alışı tickSz/lotSz/minSz kullanmaz (sz TL); aykırı adım değerlerinde yalnız limit taslakları RET beklenir.
      const valueOnly = ["tickSz 0", "lotSz 0", "tickSz çok ince", "minSz dev"].includes(name);
      const drafts: EmirDenetimiInput[] = [TL_TRAP, { ...TL_TRAP, niyetTL: undefined, sz: "202.6342" }];
      if (!valueOnly) drafts.push({ ...TL_TRAP, ordType: "market", px: undefined, sz: "10000" });
      for (const draft of drafts) {
        const r = await postEmir(base, draft);
        expect(r.status, name).toBe(200);
        const out = await js(r);
        expect(out.karar, `${name} ${JSON.stringify(draft)}`).toBe("RET");
        expect(out.duzeltme).toBeUndefined();
      }
    }
  });

  it("S-1 enstrüman hatası önbelleğe alınmaz; OKX düzelince denetim yeniden çalışır", async () => {
    const { base, fake } = await start();
    fake.override.fn = (p) => (p.endsWith("instruments") ? json({ code: "50001", data: [] }, 503) : undefined);
    expect((await js(await postEmir(base, TL_TRAP))).karar).toBe("RET");
    fake.override.fn = null;
    expect((await js(await postEmir(base, TL_TRAP))).karar).toBe("DÜZELT");
  });

  const candleFailures: [string, Override][] = [
    ["HTTP 500", (p) => (p.endsWith("candles") ? json({ code: "0", data: [] }, 500) : undefined)],
    ["code≠0", (p) => (p.endsWith("candles") ? json({ code: "50011", msg: "Too Many Requests", data: [] }, 429) : undefined)],
    ["JSON değil", (p) => (p.endsWith("candles") ? new Response("upstream timeout", { status: 200 }) : undefined)],
    ["boş", (p) => (p.endsWith("candles") ? json({ code: "0", data: [] }) : undefined)],
    ["8 alanlı satır (confirm yok)", (p, u) => (p.endsWith("candles") && u.searchParams.get("instId") === "BTC-USDT" ? json({ code: "0", data: [["1", "2", "3", "4", "5", "6", "7", "8"]] }) : undefined)],
    ["sayı olmayan fiyat", (p, u) => (p.endsWith("candles") && u.searchParams.get("bar") === "5m" && u.searchParams.get("instId") === "USDT-TRY" ? json({ code: "0", data: [[String(NOW - 600_000), "abc", "1", "1", "1", "0", "0", "0", "1"]] }) : undefined)],
    ["hepsi açık mum", (p) => (p.endsWith("candles") ? json({ code: "0", data: [[String(NOW - 120_000), "34", "34", "34", "34", "0", "0", "0", "0"]] }) : undefined)],
    [
      "ağ hatası",
      (p) => {
        if (p.endsWith("candles")) throw new Error("getaddrinfo ENOTFOUND tr.okx.com");
        return undefined;
      },
    ],
  ];

  it("S-3 mum verisi bozuk/eksik → 502, sınıf uydurulmaz, PAYMENT-RESPONSE yok, sunucu çökmez", async () => {
    for (const [name, fn] of candleFailures) {
      const { base, fake } = await start();
      fake.override.fn = fn;
      const r = await getHava(base, { "PAYMENT-SIGNATURE": mockPaymentProof() });
      expect(r.status, name).toBe(502);
      expect(r.headers.get("payment-response"), name).toBeNull();
      const body = await js(r);
      expect(body.class, name).toBeUndefined();
      expect(body.uyari).toBe("Veridir, yatırım tavsiyesi değildir.");
      expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+|node_modules|\/Users\//);
    }
  });

  it("S-3 BULGU: OKX dışı iç hata (ör. TypeError) 502 gövdesinde ham mesajıyla dışarı verilmemeli", async () => {
    // server.ts: "İç hata ayrıntısı dışarı verilmez." — liraHavaDurumu() her hatanın mesajını `hata` alanına koyuyor.
    const now = () => NOW;
    const okx = {
      candles: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'ic-ayrinti /srv/pilot/secret')");
      },
      instrument: async () => SPEC,
    };
    const server = createServisServer({ okx, weather: createLiveWeather({ okx, now }), payment: MOCK_PAY, now });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.close());
    const r = await getHava(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { "PAYMENT-SIGNATURE": mockPaymentProof() });
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toContain("ic-ayrinti");
    expect(text).not.toContain("Cannot read properties");
  });

  it("S-3 gelecekten tarihli mumlar (saat kayması) → 502; sınıf uydurulmaz", async () => {
    // OKX'in ileri tarihli (kapanmış işaretli) satır döndürdüğünü taklit et
    const { base: b2, fake } = await start();
    fake.override.fn = (p, u) => {
      if (!p.endsWith("candles")) return undefined;
      const bar = u.searchParams.get("bar") === "1H" ? 3_600_000 : 300_000;
      const rows = Array.from({ length: 300 }, (_, i) => [String(NOW + 3_600_000 - i * bar), "34", "34", "34", "34", "0", "0", "0", "1"]);
      return json({ code: "0", data: rows });
    };
    const r = await getHava(b2, { "PAYMENT-SIGNATURE": mockPaymentProof() });
    expect(r.status).toBe(502);
    expect((await js(r)).class).toBeUndefined();
  });

  it("S-3 OKX hatası bölüm durumunu bozmaz: 01:20'de hata, 01:25'te fırtına hâlâ KRIPTO_SISMESI (kural 14)", async () => {
    const { base, fake, setNow } = await start();
    const proof = { "PAYMENT-SIGNATURE": mockPaymentProof() };
    expect((await js(await getHava(base, proof))).class).toBe("KRIPTO_SISMESI");
    setNow(utcMs(2024, 8, 5, 1, 22));
    fake.override.fn = (p) => (p.endsWith("candles") ? json({ code: "50011", data: [] }, 429) : undefined);
    expect((await getHava(base, proof)).status).toBe(502);
    fake.override.fn = null;
    setNow(utcMs(2024, 8, 5, 1, 27));
    const later = await js(await getHava(base, proof));
    expect(later.ts).toBe(utcMs(2024, 8, 5, 1, 25));
    expect(later.class).toBe("KRIPTO_SISMESI");
    expect(later.episode).toMatchObject({ startTs: utcMs(2024, 8, 5, 1, 15) });
  });

  it("S-3 eşzamanlı ücretli çağrılar aynı sonucu verir; bölüm durumu yarışmaz", async () => {
    const { base } = await start();
    const proof = { "PAYMENT-SIGNATURE": mockPaymentProof() };
    const bodies = await Promise.all(Array.from({ length: 8 }, () => getHava(base, proof).then(js)));
    for (const b of bodies) {
      expect(b.class).toBe("KRIPTO_SISMESI");
      expect(b.ts).toBe(utcMs(2024, 8, 5, 1, 15));
    }
  });

  it("S-3 PAYMENT-REQUIRED başlığı geçerli base64 JSON; encodeHeader ile çözümlenir (402 gövdesiyle tutarlı)", async () => {
    const { base } = await start();
    const r = await getHava(base);
    const hdr = r.headers.get("payment-required")!;
    const body = await js(r);
    expect(hdr).toBe(encodeHeader(body.odemeGerekli));
  });
});
