/**
 * Ajan kartını (`agent.json`) tokenURI'den güvenle getirir. URI kayıt sahibi tarafından yazılır, yani saldırgan
 * girdisidir: yalnız https (ya da yerel kipte http://127.0.0.1 / localhost), yönlendirme yok, boyut ve süre sınırlı,
 * özel/iç ağ adresleri reddedilir (SSRF), gövde zod ile doğrulanır. Hata kullanıcıya gösterilebilir Türkçe nedendir.
 *
 * TODO(spec): alan adı çözümlemesi (DNS rebinding) burada kapatılmıyor; üretimde çıkış güvenlik duvarı gerekir.
 * TODO(spec): ipfs:// ve data: URI'leri desteklenmiyor (en dar seçenek); ERC-8004 kartları bunları kullanabilir.
 */
import { AgentCardSchema, type AgentCard } from "@pilot/shared";

/** TODO(spec): SPEC sınır vermiyor; kart küçük bir JSON'dur. */
export const CARD_MAX_BYTES = 64 * 1024;
export const CARD_TIMEOUT_MS = 5_000;

export type CardResult = { ok: true; card: AgentCard } | { ok: false; reasonTr: string };

export interface CardFetchOptions {
  /** Yerel kip: http://127.0.0.1 ve http://localhost'a izin verir (anvil/yerel demo). */
  local: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".lan", ".home", ".corp"];

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
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
  const host = u.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost";
  if (u.protocol === "http:" && local && isLoopback) return u;
  if (u.protocol !== "https:") return "Ajan kartı yalnız https adresinden okunur.";
  if (u.port !== "") return "Ajan kartı adresinde özel port olamaz.";
  if (host.startsWith("[") || ipv4Private(host) || !host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return "Ajan kartı iç ağ ya da özel bir adrese işaret ediyor.";
  }
  return u;
}

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
  const f = opts.fetch ?? globalThis.fetch;
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
