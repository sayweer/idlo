/**
 * Gerçek KULE istemcisi: MCP Streamable HTTP (§9: `…/mcp`, istemci başına bearer token; PİLOT için PILOT_TOKEN).
 * Girdi/çıktı doğrulaması ValidatingKuleClient'tadır. KULE sunucusu Bekir'dedir (apps/kule); burada yalnız istemci var.
 *
 * Yanıt biçimi: `structuredContent` varsa o; yoksa tek bir `text` içeriği JSON olarak okunur.
 * TODO(spec): §9.1 MCP yanıtının structuredContent mi metin mi olacağını yazmıyor; ikisi de kabul edilir,
 * başka her biçim (birden çok blok, JSON olmayan metin, isError) KuleError'dır.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { KuleToolName } from "@pilot/shared";
import { KuleError, ValidatingKuleClient } from "./kule.js";

/** MCP istemcisinden yalnız gereken parça (test için daraltıldı). */
export interface McpToolCaller {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<Record<string, unknown>>;
  close?(): Promise<void>;
}

/**
 * Zaman aşımları. TODO(spec): SPEC vermiyor. kule_execute post_only'de en fazla 10 dk bekleyebilir (§9.2-13);
 * en dar seçim 11 dk. Diğerleri 30 sn. Zaman aşımında sonuç belirsizdir; KULE aynı izni ikinci kez açmaz (§9.2-2).
 */
export const KULE_TIMEOUT_MS = 30_000;
export const KULE_EXECUTE_TIMEOUT_MS = 11 * 60_000;

export class McpKuleClient extends ValidatingKuleClient {
  constructor(private readonly mcp: McpToolCaller) {
    super();
  }

  protected async send(name: KuleToolName, args: Record<string, unknown>): Promise<unknown> {
    const timeout = name === "kule_execute" ? KULE_EXECUTE_TIMEOUT_MS : KULE_TIMEOUT_MS;
    const res = await this.mcp.callTool({ name, arguments: args }, undefined, { timeout });
    if (res.isError === true) throw new KuleError(`${name}: KULE araç hatası döndürdü`, name);
    if (res.structuredContent !== undefined && res.structuredContent !== null) return res.structuredContent;
    const content = res.content;
    if (!Array.isArray(content) || content.length !== 1) throw new KuleError(`${name}: KULE yanıtında tek içerik yok`, name);
    const block = content[0] as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") throw new KuleError(`${name}: KULE yanıtı metin değil`, name);
    try {
      return JSON.parse(block.text) as unknown;
    } catch {
      throw new KuleError(`${name}: KULE yanıtı JSON değil`, name);
    }
  }

  async close(): Promise<void> {
    await this.mcp.close?.();
  }
}

/**
 * Token yalnız HTTPS üzerinden gider; düz HTTP yalnız yerel geri döngü adresine (VPS'te 127.0.0.1:8787, §6.5).
 * TODO(spec): SPEC bunu açıkça yazmıyor; bearer token'ın açık ağda gitmemesi için en dar seçim.
 */
export function assertKuleUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("KULE_URL geçerli bir URL değil");
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) {
    throw new Error("KULE_URL https olmalı (düz http yalnız 127.0.0.1/localhost için)");
  }
  if (u.username || u.password) throw new Error("KULE_URL kullanıcı adı/parola içermemeli");
  return u;
}

export interface ConnectKuleOptions {
  url: string;
  /** PILOT_TOKEN. Günlüğe yazılmaz. */
  token: string;
  /** Test için fetch enjeksiyonu. */
  fetch?: typeof fetch;
}

/** KULE'ye bağlanır (MCP initialize) ve doğrulayıcı istemciyi döndürür. */
export async function connectKule(o: ConnectKuleOptions): Promise<McpKuleClient> {
  const url = assertKuleUrl(o.url);
  if (typeof o.token !== "string" || !/^\S{16,}$/.test(o.token)) {
    // TODO(spec): token biçimi SPEC'te yok; en az 16 boşluksuz karakter (kısa/boş token ile bağlanılmaz).
    throw new Error("PILOT_TOKEN boş ya da çok kısa");
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${o.token}` } },
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const client = new Client({ name: "pilot", version: "0.0.0" });
  await client.connect(transport);
  return new McpKuleClient(client as unknown as McpToolCaller);
}
