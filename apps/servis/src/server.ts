/**
 * Servis HTTP sunucusu (SPEC §12): A2MCP uç noktaları + Streamable HTTP MCP (`/mcp`, durumsuz).
 * Yalnız 127.0.0.1'e bağlanır (index.ts); dışarıya Caddy üzerinden açılır (§6.5). Anahtar yok, kimlik doğrulama yok:
 * yalnız herkese açık veri ve saf denetim (CLAUDE.md kural 6).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { WeatherSchema } from "@pilot/shared";
import { EmirDenetimiInputSchema, EmirDenetimiOutputSchema } from "./emirDenetimi.js";
import { MOCK_LABEL, PAYMENT_SIGNATURE_HEADER } from "./odeme.js";
import { emirDenetimi, liraHavaDurumu, type ServisDeps } from "./servis.js";

export const EMIR_DENETIMI_PATH = "/a2mcp/emir-denetimi";
export const LIRA_HAVA_DURUMU_PATH = "/a2mcp/lira-hava-durumu";
export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 16 * 1024;

export const EMIR_DENETIMI_TOOL = "emir_denetimi";
export const LIRA_HAVA_DURUMU_TOOL = "lira_hava_durumu";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "İstek gövdesi çok büyük.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "İstek gövdesi geçerli JSON değil.");
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const MCP_IC_HATA = "İç hata.";

/** Bilinmeyen hata MCP araç hatası metnine sızmaz (sunucunun "iç hata ayrıntısı dışarı verilmez" kuralı). */
function mcpInternalError(tool: string, e: unknown) {
  console.error(`[servis] ${tool}: ${String(e)}`);
  return { isError: true, content: [{ type: "text" as const, text: MCP_IC_HATA }] };
}

/** Her MCP isteği için yeni sunucu (durumsuz Streamable HTTP). */
function buildMcpServer(deps: ServisDeps): McpServer {
  const odemeModu = deps.payment.mock
    ? `Bu kurulumda ${MOCK_LABEL}.`
    : "Gerçek x402 henüz etkin değil; ücretli servis kapalı.";
  const mcp = new McpServer({ name: "pilot-servis", version: "0.0.0" });

  mcp.registerTool(
    EMIR_DENETIMI_TOOL,
    {
      title: "Emir Denetimi",
      description:
        "USDT-TRY alış emri taslağını birimleriyle okur (piyasa alışında sz TL, limit alışta sz USDT), fiyat adımını ve tavanı denetler. " +
        "ONAY, DÜZELT ya da RET ve Türkçe gerekçe döner. Emir göndermez. Ücretsiz.",
      inputSchema: EmirDenetimiInputSchema,
      outputSchema: EmirDenetimiOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const out = await emirDenetimi(deps, input);
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        return mcpInternalError(EMIR_DENETIMI_TOOL, e);
      }
    },
  );

  mcp.registerTool(
    LIRA_HAVA_DURUMU_TOOL,
    {
      title: "Lira Hava Durumu",
      description:
        "USDT-TRY fırtına sınıfı (NORMAL, TL_GUCLENDI, KRIPTO_SISMESI, PRIM_SISMESI, BELIRSIZ, LIRA_ZAYIFLADI) ve ölçümleri. " +
        `Veridir, yatırım tavsiyesi değildir. Ücretli (x402); ödeme ${PAYMENT_SIGNATURE_HEADER} HTTP başlığıyla. ${odemeModu}`,
      inputSchema: z.strictObject({}),
      outputSchema: z.looseObject({ ...WeatherSchema.shape, kaynak: z.string(), zaman: z.int(), uyari: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    // TODO(spec): MCP üzerinden x402 kuralı `[DOĞRULA]`; kanıt MCP isteğinin HTTP başlığından okunur, 402 araç hatası olarak döner.
    async (_input, extra) => {
      try {
        const header = headerValue(extra.requestInfo?.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()]);
        const r = await liraHavaDurumu(deps, header, LIRA_HAVA_DURUMU_PATH);
        const structuredContent = { durum: r.status, ...r.body };
        const text = JSON.stringify(structuredContent);
        if (r.status !== 200) return { isError: true, content: [{ type: "text", text }], structuredContent };
        return { content: [{ type: "text", text }], structuredContent, _meta: { "x402/payment-response": r.headers } };
      } catch (e) {
        return mcpInternalError(LIRA_HAVA_DURUMU_TOOL, e);
      }
    },
  );
  return mcp;
}

async function handleMcp(deps: ServisDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mcp = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, await readJson(req));
}

export function createServisServer(deps: ServisDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === EMIR_DENETIMI_PATH) {
        if (req.method !== "POST") throw new HttpError(405, "Yalnız POST.");
        const parsed = EmirDenetimiInputSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return sendJson(res, 400, { hata: "Emir taslağı şemaya uymuyor.", ayrintilar: z.flattenError(parsed.error) });
        }
        return sendJson(res, 200, await emirDenetimi(deps, parsed.data));
      }
      if (path === LIRA_HAVA_DURUMU_PATH) {
        if (req.method !== "GET") throw new HttpError(405, "Yalnız GET.");
        const r = await liraHavaDurumu(deps, headerValue(req.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()]), LIRA_HAVA_DURUMU_PATH);
        return sendJson(res, r.status, r.body, r.headers);
      }
      if (path === MCP_PATH) {
        // Durumsuz JSON yanıt kipi: GET (SSE akışı) ve DELETE (oturum) gereksiz; süresiz açık akış kaynak tüketir.
        if (req.method !== "POST") return sendJson(res, 405, { hata: "Yalnız POST." }, { allow: "POST" });
        return handleMcp(deps, req, res);
      }
      throw new HttpError(404, "Bulunamadı.");
    })().catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { hata: e.message });
      // İç hata ayrıntısı dışarı verilmez.
      sendJson(res, 500, { hata: "İç hata." });
    });
  });
}
