/**
 * PİLOT'un ERC-8004 kayıt dosyası (`/agent.json`, SPEC §8.5, UI_HANDOFF §2.6). Saf modül (betikler ve testler).
 * Web şu an bunu içe aktaramaz (`@pilot/scripts` web'in bağımlılığı değil); zorunlu değerler UI_HANDOFF §2.6'da.
 * Şablon: data/agent-card/agent.json (yer tutucu alan adlarıyla; testler şablonun bu kurucuyla aynı kaldığını denetler).
 */
import { z } from "zod";
import { ERC8004_FUJI, FUJI_CHAIN_ID, Uint256StringSchema } from "@pilot/shared";

/** TODO(spec): §8.5 `type` değerini vermiyor; EIP-8004 kayıt dosyası türü kullanıldı. [DOĞRULA] */
export const AGENT_CARD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
/** §8.5: agentRegistry = "eip155:43113:<Identity>". */
export const FUJI_AGENT_REGISTRY = `eip155:${FUJI_CHAIN_ID}:${ERC8004_FUJI.identity}` as const;
/** TODO(spec): §8.5 değer vermiyor. En dar doğru beyan: yalnız Reputation kaydı kullanılıyor. [DOĞRULA] */
export const SUPPORTED_TRUST = ["reputation"] as const;
export const AGENT_NAME = "PİLOT";
export const AGENT_DESCRIPTION =
  "PİLOT, Elif'in imzaladığı Uçuş Planı içinde TL'yi USDT'ye çeviren ajandır. Lira Hava Durumu'nu okur; " +
  "her alım için Fuji'deki Uçuş Planı kontratından izin ister. Emri KULE verir; ajanın çekim yetkisi yoktur.";

/** Şablondaki yer tutucu alan adı; kayıt öncesi gerçek adla değişmeli. */
export const PLACEHOLDER_HOST = "ALANADI";

const httpsUrl = z.string().refine((s) => {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}, "https URL olmalı");

/** Kayıt dosyası şeması. Bilinmeyen alanlara izin verir (web ileride ekleyebilir), bilinenleri sıkı denetler. */
export const AgentCardSchema = z.object({
  type: z.literal(AGENT_CARD_TYPE),
  name: z.literal(AGENT_NAME),
  description: z.string().min(1),
  image: httpsUrl,
  // TODO(spec): servisin MCP yolu SPEC'te yok (UI_HANDOFF §2.6); uç nokta çağırandan gelir.
  services: z.array(z.strictObject({ name: z.literal("MCP"), endpoint: httpsUrl })).length(1),
  active: z.boolean(),
  registrations: z
    .array(
      z.strictObject({
        // [DOĞRULA] EIP örneği agentId'yi JSON sayısı olarak yazar; güvenli tamsayı aralığı dışı reddedilir.
        agentId: z.int().nonnegative(),
        agentRegistry: z.literal(FUJI_AGENT_REGISTRY),
      }),
    )
    .max(1),
  supportedTrust: z.array(z.enum(SUPPORTED_TRUST)),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

export interface AgentCardInput {
  /** Görselin tam https URL'si (web `public/` altında). */
  imageUrl: string;
  /** Servisin MCP uç noktası (https). */
  mcpEndpoint: string;
  /** `fuji.json.agentId` (uint256 ondalık string). Yoksa kayıt listesi boş kalır. */
  agentId?: string;
}

export function buildAgentCard(input: AgentCardInput): AgentCard {
  let registrations: AgentCard["registrations"] = [];
  if (input.agentId !== undefined) {
    const id = BigInt(Uint256StringSchema.parse(input.agentId));
    if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`agentId JSON sayısına sığmıyor: ${input.agentId}`);
    registrations = [{ agentId: Number(id), agentRegistry: FUJI_AGENT_REGISTRY }];
  }
  return AgentCardSchema.parse({
    type: AGENT_CARD_TYPE,
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    image: input.imageUrl,
    services: [{ name: "MCP", endpoint: input.mcpEndpoint }],
    active: true,
    registrations,
    supportedTrust: [...SUPPORTED_TRUST],
  });
}

/** Yerel makine adları (`URL.hostname` biçiminde). */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Kayda yazılacak agentURI'yi denetler (§8.5: `https://<web>/agent.json`).
 * https zorunlu (yalnız `local` iken yerel makinede http), yol tam olarak `/agent.json`, sorgu/parça ve yer tutucu yok.
 * Girdi kanonik biçimde olmalı (`new URL(uri).href === uri`): ayrıştırıcının sessizce düzelttiği metin (boşluk, sekme,
 * ters bölü, `..`/`.`, büyük harfli alan adı, varsayılan port, boş `?`/`#`) reddedilir; böylece denetlenen URL ile
 * zincire yazılan metin aynıdır. Dönen değer zincire yazılacak metindir.
 */
export function validateAgentUri(uri: string, opts: { local: boolean }): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Error(`agentURI geçerli URL değil: ${JSON.stringify(uri)}`);
  }
  if (u.href !== uri) throw new Error(`agentURI kanonik biçimde değil (ayrıştırıcı ${JSON.stringify(u.href)} yapıyor): ${JSON.stringify(uri)}`);
  // href boş bir `?`/`#`'yi korur (ör. "…/agent.json?"); bu yüzden ayrıca reddedilir.
  if (uri.includes("?") || uri.includes("#")) throw new Error(`agentURI sorgu ya da parça içeremez: ${uri}`);
  const localHttp = opts.local && u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !localHttp) throw new Error(`agentURI https olmalı: ${uri}`);
  if (u.pathname !== "/agent.json") throw new Error(`agentURI yolu /agent.json olmalı: ${uri}`);
  if (u.search || u.hash || u.username || u.password) throw new Error(`agentURI sorgu, parça ya da kullanıcı bilgisi içeremez: ${uri}`);
  if (uri.toUpperCase().includes(PLACEHOLDER_HOST)) throw new Error(`agentURI yer tutucu içeriyor (${PLACEHOLDER_HOST}): ${uri}`);
  return uri;
}

/** Yayındaki kayıt dosyasını denetler: şemaya uymalı ve yer tutucu kalmamalı. */
export function checkServedCard(raw: unknown): AgentCard {
  const r = AgentCardSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`agent.json geçersiz: ${r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  }
  if (JSON.stringify(r.data).toUpperCase().includes(PLACEHOLDER_HOST)) {
    throw new Error(`agent.json hâlâ yer tutucu içeriyor (${PLACEHOLDER_HOST}); gerçek alan adlarını yaz`);
  }
  return r.data;
}
