/**
 * KULE ortam yapılandırması (SPEC Ek B, apps/kule/.env). Anahtarlar yalnız .env'den okunur; hata mesajlarında hiçbir
 * değer (token, anahtar, parola) geçmez (CLAUDE.md kural 5). Fail-closed: eksik/bozuk alan → ConfigError, sunucu açılmaz.
 *
 * Token → ajan bağı (§9.2-1): PILOT_TOKEN → PILOT_AGENT_ADDRESS; DEMO_CLIENT_TOKEN (isteğe bağlı
 * DEMO_CLIENT_AGENT_ADDRESS); AGENT_TOKENS="token:0xadres,..." (ajan başına tek token).
 * TODO(spec): DEMO_CLIENT_TOKEN için ajan adresi verilmezse token yalnız okuma/teklif araçlarını kullanabilir;
 * kule_execute WRONG_AGENT döner.
 */
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseDeployments, type Deployments, type KuleMode } from "@pilot/shared";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface TokenBinding {
  /** Bearer token (günlüğe/hataya yazılmaz). */
  token: string;
  /** Bağlı ajan adresi; null = ajansız (yalnız okuma/teklif). */
  agent: Address | null;
  /** Günlükte kullanılan ad ("pilot", "demo", "agent1"…); token değeri değildir. */
  label: string;
}

export interface OkxCreds {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface KuleConfig {
  port: number;
  tokens: TokenBinding[];
  planUser: Address;
  okxProfile: string;
  exec: "okx" | "paper";
  okx: OkxCreds | null;
  demo: boolean;
  mode: KuleMode;
  reporterKey: Hex;
  reporter: Address;
  rpcUrl: string;
  deployments: Deployments;
  actionsPath: string;
  logDir: string;
}

type Env = Record<string, string | undefined>;

function opt(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}
function need(env: Env, name: string): string {
  const v = opt(env, name);
  if (!v) throw new ConfigError(`${name} tanımlı değil`);
  return v;
}

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,128}$/;
export function assertToken(t: string, name: string): string {
  if (!TOKEN_RE.test(t)) throw new ConfigError(`${name} biçimi geçersiz (16–128 karakter; harf, rakam ve ._~+/=-)`);
  return t;
}

function addr(v: string, name: string): Address {
  if (!isAddress(v, { strict: false }) || isAddressEqual(v as Address, zeroAddress)) {
    throw new ConfigError(`${name} geçerli bir adres değil`);
  }
  return getAddress(v.toLowerCase());
}

/** AGENT_TOKENS="token:0xadres,token2:0xadres2" */
export function parseAgentTokens(raw: string): { token: string; agent: Address }[] {
  const out: { token: string; agent: Address }[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p === "") continue;
    const i = p.indexOf(":");
    if (i <= 0) throw new ConfigError("AGENT_TOKENS biçimi: token:0xadres,token:0xadres");
    const token = assertToken(p.slice(0, i).trim(), "AGENT_TOKENS token");
    out.push({ token, agent: addr(p.slice(i + 1).trim(), "AGENT_TOKENS adres") });
  }
  return out;
}

export function buildTokenBindings(env: Env): TokenBinding[] {
  const list: TokenBinding[] = [];

  const pilotToken = opt(env, "PILOT_TOKEN");
  const pilotAgent = opt(env, "PILOT_AGENT_ADDRESS");
  if (pilotToken !== undefined || pilotAgent !== undefined) {
    if (!pilotToken) throw new ConfigError("PILOT_TOKEN tanımlı değil");
    if (!pilotAgent) throw new ConfigError("PILOT_AGENT_ADDRESS tanımlı değil");
    list.push({ token: assertToken(pilotToken, "PILOT_TOKEN"), agent: addr(pilotAgent, "PILOT_AGENT_ADDRESS"), label: "pilot" });
  }

  const demoToken = opt(env, "DEMO_CLIENT_TOKEN");
  if (demoToken !== undefined) {
    const demoAgent = opt(env, "DEMO_CLIENT_AGENT_ADDRESS");
    list.push({
      token: assertToken(demoToken, "DEMO_CLIENT_TOKEN"),
      agent: demoAgent ? addr(demoAgent, "DEMO_CLIENT_AGENT_ADDRESS") : null,
      label: "demo",
    });
  } else if (opt(env, "DEMO_CLIENT_AGENT_ADDRESS")) {
    throw new ConfigError("DEMO_CLIENT_AGENT_ADDRESS var ama DEMO_CLIENT_TOKEN tanımlı değil");
  }

  const extra = opt(env, "AGENT_TOKENS");
  if (extra) {
    parseAgentTokens(extra).forEach((t, i) => list.push({ token: t.token, agent: t.agent, label: `agent${i + 1}` }));
  }

  if (list.length === 0) throw new ConfigError("hiç token tanımlı değil (PILOT_TOKEN, DEMO_CLIENT_TOKEN ya da AGENT_TOKENS)");
  if (!list.some((t) => t.agent !== null)) throw new ConfigError("ajana bağlı hiç token yok; kule_execute kimse için çalışmaz");

  // Token'lar tekil; ajan başına tek token (çok ajanlı yön).
  const tokens = new Set<string>();
  const agents = new Set<string>();
  for (const t of list) {
    if (tokens.has(t.token)) throw new ConfigError("aynı token birden fazla yerde tanımlı");
    tokens.add(t.token);
    if (t.agent) {
      const k = t.agent.toLowerCase();
      if (agents.has(k)) throw new ConfigError("bir ajan adresine birden fazla token bağlanamaz");
      agents.add(k);
    }
  }
  return list;
}

function rpcOk(url: string): boolean {
  try {
    const u = new URL(url);
    const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    return !u.username && !u.password && (u.protocol === "https:" || (u.protocol === "http:" && loop));
  } catch {
    return false;
  }
}

export interface LoadConfigOptions {
  /** DEPLOYMENTS ve data/logs yollarının tabanı (apps/kule). */
  baseDir: string;
  readText: (path: string) => string;
  resolvePath: (base: string, p: string) => string;
}

export function loadConfig(env: Env, o: LoadConfigOptions): KuleConfig {
  const portRaw = opt(env, "KULE_PORT") ?? "8787";
  const port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("KULE_PORT geçersiz");

  const tokens = buildTokenBindings(env);

  const planUser = addr(need(env, "PLAN_USER_ADDRESS"), "PLAN_USER_ADDRESS");

  const exec = opt(env, "KULE_EXEC") ?? "okx";
  if (exec !== "okx" && exec !== "paper") throw new ConfigError("KULE_EXEC okx ya da paper olmalı");

  const okxProfile = opt(env, "OKX_PROFILE") ?? "kule-demo";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(okxProfile)) throw new ConfigError("OKX_PROFILE geçersiz");

  const demoRaw = opt(env, "OKX_DEMO") ?? "1";
  if (demoRaw !== "0" && demoRaw !== "1") throw new ConfigError("OKX_DEMO 0 ya da 1 olmalı");
  const demo = demoRaw === "1";
  // Profil adı ile demo bayrağı çelişirse CAA yanlış ortama gider.
  if (okxProfile === "kule-demo" && !demo) throw new ConfigError("OKX_PROFILE=kule-demo iken OKX_DEMO=1 olmalı");
  if (okxProfile === "kule" && demo) throw new ConfigError("OKX_PROFILE=kule iken OKX_DEMO=0 olmalı");

  const apiKey = opt(env, "OKX_API_KEY");
  const secretKey = opt(env, "OKX_SECRET_KEY");
  const passphrase = opt(env, "OKX_PASSPHRASE");
  let okx: OkxCreds | null = null;
  if (apiKey && secretKey && passphrase) okx = { apiKey, secretKey, passphrase };
  else if (exec === "okx") throw new ConfigError("OKX_API_KEY, OKX_SECRET_KEY ve OKX_PASSPHRASE tanımlı olmalı (Cancel-All-After için)");

  const pk = need(env, "KULE_REPORTER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new ConfigError("KULE_REPORTER_PRIVATE_KEY biçimi geçersiz");
  let reporter: Address;
  try {
    reporter = privateKeyToAccount(pk as Hex).address;
  } catch {
    throw new ConfigError("KULE_REPORTER_PRIVATE_KEY geçersiz");
  }

  const rpcUrl = need(env, "FUJI_RPC");
  if (!rpcOk(rpcUrl)) throw new ConfigError("FUJI_RPC https olmalı (düz http yalnız 127.0.0.1/localhost için)");

  let deployments: Deployments;
  try {
    deployments = parseDeployments(o.readText(o.resolvePath(o.baseDir, need(env, "DEPLOYMENTS"))));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`DEPLOYMENTS okunamadı: ${(e as Error).message}`);
  }
  if (!isAddressEqual(reporter, deployments.kuleReporter)) {
    throw new ConfigError("KULE_REPORTER_PRIVATE_KEY adresi deployments'taki kuleReporter ile eşleşmiyor");
  }

  const mode: KuleMode = exec === "paper" ? "paper" : demo ? "demo" : "live";
  return {
    port,
    tokens,
    planUser,
    okxProfile,
    exec,
    okx,
    demo,
    mode,
    reporterKey: pk as Hex,
    reporter,
    rpcUrl,
    deployments,
    actionsPath: o.resolvePath(o.baseDir, "data/kule-actions.json"),
    logDir: o.resolvePath(o.baseDir, "logs"),
  };
}
