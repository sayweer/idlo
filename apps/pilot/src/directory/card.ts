/**
 * Ajan kartını (`agent.json`) tokenURI'den güvenle getirir. URI kayıt sahibi tarafından yazılır, yani saldırgan
 * girdisidir: yalnız https (ya da yerel kipte http://127.0.0.1 / localhost), yönlendirme yok, boyut ve süre sınırlı,
 * özel/iç ağ adresleri reddedilir (SSRF), gövde zod ile doğrulanır. Hata kullanıcıya gösterilebilir Türkçe nedendir.
 *
 * SSRF iki katmanlıdır:
 *  1. `checkCardUri` (ad denetimi): sondaki nokta atılır, iç ağ sonekleri, IP sabitleri ve joker DNS servisleri
 *     (nip.io vb.) reddedilir. Ad denetimi tek başına yetmez: herkese açık bir ad özel IP'ye çözülebilir.
 *  2. `publicHttpsFetch` (bağlantı denetimi): varsayılan getirici, adı KENDİ çözer (`guardedLookup`) ve çözülen her
 *     adres herkese açık değilse bağlanmaz. Bağlanılan IP, denetlenen IP'dir; denetimle bağlantı arasında DNS
 *     değişemez (DNS rebinding kapalı). `opts.fetch` verilirse (test/yerel) bu katman devre dışıdır.
 * Yine de üretimde çıkış güvenlik duvarı (özel aralıklara çıkış yasağı) derinlemesine savunma olarak gerekir.
 *
 * TODO(spec): ipfs:// ve data: URI'leri desteklenmiyor (en dar seçenek); ERC-8004 kartları bunları kullanabilir.
 */
import dns from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { AgentCardSchema, type AgentCard } from "@pilot/shared";

/** TODO(spec): SPEC sınır vermiyor; kart küçük bir JSON'dur. */
export const CARD_MAX_BYTES = 64 * 1024;
export const CARD_TIMEOUT_MS = 5_000;

export type CardResult = { ok: true; card: AgentCard } | { ok: false; reasonTr: string };

export interface CardFetchOptions {
  /** Yerel kip: http://127.0.0.1 ve http://localhost'a izin verir (anvil/yerel demo). */
  local: boolean;
  /** Verilirse kullanılır ve bağlantı denetimi (guardedLookup) uygulanmaz; yalnız test/yerel demo içindir. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".lan", ".home", ".corp", ".intranet", ".private"];
/** Adındaki IP'ye çözülen joker DNS servisleri: ad denetimiyle ayırt edilemez, doğrudan reddedilir. */
const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io", ".xip.io", ".traefik.me", ".localtest.me", ".lvh.me"];

/** Küçük harf, sondaki noktalar atılmış ana makine adı (`localhost.` → `localhost`). */
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** Herkese açık olmayan IPv4 (özel, loopback, link-local, CGNAT, test/belge aralıkları, çok noktaya yayın, ayrılmış). */
export function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protokol (192.0.0.192 bulut meta verisi)
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 yayını
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 kıyaslama
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224
  );
}

/** IPv6 metnini 8 parçaya açar (`::` ve gömülü IPv4 dahil); çözülemezse null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4 !== null) {
    const o = v4[1]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, v4.index)}${(((o[0]! << 8) | o[1]!)).toString(16)}:${(((o[2]! << 8) | o[3]!)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8) return null;
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** Herkese açık olmayan IPv6 (ya da çözülemeyen: fail-closed). */
export function ipv6Private(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (g === null) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return embedded(g6, g7); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64: gömülü adres sunucuya bağlı, kapalı tut
  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, belge
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // çok noktaya yayın
  return false;
}

/** Çözülen IP herkese açık mı? (geçersiz metin: hayır) */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !ipv4Private(ip);
  if (v === 6) return !ipv6Private(ip);
  return false;
}

/** URI'yi denetler; geçerliyse URL, değilse Türkçe neden. */
export function checkCardUri(uri: string, local: boolean): URL | string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "Ajan kartının adresi geçerli bir URL değil.";
  }
  if (u.username !== "" || u.password !== "") return "Ajan kartının adresi kullanıcı bilgisi içeremez.";
  const host = normalizeHost(u.hostname);
  const isLoopback = host === "127.0.0.1" || host === "localhost";
  if (u.protocol === "http:" && local && isLoopback) return u;
  if (u.protocol !== "https:") return "Ajan kartı yalnız https adresinden okunur.";
  if (u.port !== "") return "Ajan kartı adresinde özel port olamaz.";
  if (
    host === "" ||
    host.startsWith("[") ||
    ipv4Private(host) ||
    isIP(host) !== 0 ||
    !host.includes(".") ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) ||
    WILDCARD_DNS_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    return "Ajan kartı iç ağ ya da özel bir adrese işaret ediyor.";
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * `https.request({ lookup })` için: adı çözer ve herhangi bir adres herkese açık değilse bağlantıyı reddeder.
 * Node'un bağlandığı adres bu fonksiyonun döndürdüğüdür (denetim ile bağlantı arasında ikinci çözümleme yok).
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err !== null) return cb(err, "", 0);
    if (addrs.length === 0 || addrs.some((a) => !isPublicIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error("ad herkese açık olmayan bir adrese çözülüyor");
      e.code = "EBLOCKEDADDR";
      return cb(e, "", 0);
    }
    if (options.all === true) return cb(null, addrs);
    return cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

/** Varsayılan https getirici: bağlantı IP'si `guardedLookup` ile denetlenir; yönlendirme izlenmez (reddedilir). */
export const publicHttpsFetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req = https.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        lookup: guardedLookup as unknown as https.RequestOptions["lookup"],
        ...(init?.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
          res.destroy();
          reject(new Error(`yönlendirme ya da geçersiz durum: ${status}`));
          return;
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(", "));
        }
        const noBody = status === 204 || status === 205;
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  })) as typeof fetch;

async function readLimited(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (res.body === null) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

export async function fetchAgentCard(uri: string, opts: CardFetchOptions): Promise<CardResult> {
  const checked = checkCardUri(uri, opts.local);
  if (typeof checked === "string") return { ok: false, reasonTr: checked };
  // Enjekte getirici yoksa: https → bağlantı IP'sini denetleyen getirici; yerel http loopback → global fetch.
  const f = opts.fetch ?? (checked.protocol === "https:" ? publicHttpsFetch : globalThis.fetch);
  const maxBytes = opts.maxBytes ?? CARD_MAX_BYTES;
  let text: string | null;
  try {
    const res = await f(checked.href, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? CARD_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reasonTr: `Ajan kartı alınamadı (HTTP ${res.status}).` };
    text = await readLimited(res, maxBytes);
  } catch {
    return { ok: false, reasonTr: "Ajan kartı alınamadı (bağlantı hatası, zaman aşımı ya da yönlendirme)." };
  }
  if (text === null) return { ok: false, reasonTr: "Ajan kartı çok büyük ya da okunamadı." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reasonTr: "Ajan kartı geçerli JSON değil." };
  }
  const r = AgentCardSchema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    return { ok: false, reasonTr: `Ajan kartı şemaya uymuyor (${first ? first.path.join(".") || "kök" : "?"}).` };
  }
  return { ok: true, card: r.data };
}
