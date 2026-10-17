/**
 * MCP sunucusu (§9): Streamable HTTP, 127.0.0.1:${KULE_PORT}/mcp, bearer token. Tam olarak §9.1'deki araçlar
 * (packages/shared/tools/kule.ts); girdi ve çıktı zod ile doğrulanır (çıktı şemaya uymazsa araç hatası, fail-closed).
 *
 * Durumsuz (stateless) mod: her HTTP isteği için yeni Server + taşıma; token isteğin kendisinde. Yanıt SSE akışıdır ve
 * SDK 15 sn'de bir keep-alive yorum satırı yollar; böylece kule_execute post_only'de 10 dk beklerken istemci
 * (undici bodyTimeout 300 sn) bağlantıyı koparmaz.
 * Yanıt biçimi: structuredContent (nesne) + aynı JSON tek `text` bloğu (PİLOT kuleMcp.ts ikisini de okur).
 * TODO(spec): geçersiz token HTTP 401 ile reddedilir (MCP'ye girmeden); executor ayrıca AUTH RET'ini de uygular.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { KULE_TOOLS, KULE_TOOL_NAMES, type KuleToolName } from "@pilot/shared";
import { bearerOf, type TokenRegistry } from "./auth.js";
import type { TokenBinding } from "./config.js";
import type { Logger } from "./logger.js";
import type { KuleService } from "./service.js";
import { errText } from "./util.js";

export const KULE_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_000_000;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function textError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** shared'daki şemalar bazı ifadeleri (refine, custom) JSON Schema'ya çeviremez; listeleme için "any" yeterli. */
function inputJsonSchema(name: KuleToolName): Record<string, unknown> {
  const raw = z.toJSONSchema(KULE_TOOLS[name].input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  void _ignored;
  return rest.type === "object" ? rest : { type: "object", ...rest };
}

function parseNoThrow<S extends z.ZodType>(schema: S, v: unknown): { ok: true; data: z.output<S> } | { ok: false; msg: string } {
  try {
    const r = schema.safeParse(v);
    if (r.success) return { ok: true, data: r.data };
    return { ok: false, msg: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`).join("; ") };
  } catch {
    return { ok: false, msg: "doğrulama hata verdi" };
  }
}

export function makeToolHandler(service: KuleService, logger: Logger) {
  return async function handleCall(name: string, args: unknown, binding: TokenBinding): Promise<ToolResult> {
    if (!(KULE_TOOL_NAMES as readonly string[]).includes(name)) return textError(`Bilinmeyen araç: ${name}`);
    const tool = name as KuleToolName;
    const def = KULE_TOOLS[tool];
    const input = parseNoThrow(def.input, args ?? {});
    if (!input.ok) return textError(`Girdi şemaya uymuyor (${input.msg})`);
    let out: unknown;
    try {
      out = await service.call(tool, input.data, binding);
    } catch (e) {
      logger.log({ tool, event: "tool_error", caller: binding.label, error: errText(e) });
      return textError("KULE araç hatası; işlem yapılmadı ya da sonucu belirsiz.");
    }
    const o = parseNoThrow(def.output, out);
    if (!o.ok) {
      logger.log({ tool, event: "output_schema_mismatch", caller: binding.label, error: o.msg });
      return textError("KULE yanıtı şemaya uymuyor.");
    }
    const data = o.data as unknown;
    const structured = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: structured };
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("gövde çok büyük"), { status: 413 });
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("geçersiz JSON"), { status: 400 });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface KuleServerOptions {
  registry: TokenRegistry;
  service: KuleService;
  logger: Logger;
}

export function createKuleHttpServer(o: KuleServerOptions): HttpServer {
  const handleCall = makeToolHandler(o.service, o.logger);

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://kule.local");
        if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "bulunamadı" });

        const binding = o.registry.resolve(bearerOf(req.headers.authorization));
        if (!binding) {
          o.logger.log({ tool: "http", event: "auth_failed" });
          return sendJson(res, 401, { error: "Geçersiz erişim anahtarı." }, { "WWW-Authenticate": "Bearer" });
        }
        if (req.method !== "POST") return sendJson(res, 405, { error: "yalnız POST" }, { Allow: "POST" });

        const body = await readBody(req);

        const server = new Server({ name: "kule", version: "0.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: KULE_TOOL_NAMES.map((name) => ({ name, description: KULE_TOOLS[name].description, inputSchema: inputJsonSchema(name) as { type: "object" } })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (r) => handleCall(r.params.name, r.params.arguments, binding));

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        if (status === 500) o.logger.log({ tool: "http", event: "server_error", error: errText(e) });
        sendJson(res, status, { error: status === 500 ? "sunucu hatası" : (e as Error).message });
      }
    })();
  });
}

export function listen(server: HttpServer, port: number, host = KULE_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : port);
    });
  });
}
