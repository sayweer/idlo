/**
 * PİLOT ortam yapılandırması (Ek B, apps/pilot/.env). Anahtar yalnız .env'den okunur, hemen hesaba çevrilir ve
 * saklanmaz; hata mesajlarında hiçbir değer (anahtar, token) geçmez (CLAUDE.md kural 5).
 *
 * Fail-closed: eksik/bozuk alan, sıfır adres ya da anahtarın adresi deployments'taki pilotAgent değilse hata.
 * Kullanıcı (Elif) PLAN_USER_ADDRESS'ten sabitlenir; LLM girdisinden asla gelmez (görev C4).
 * TODO(spec): Ek B PİLOT için kullanıcı adresi alanı vermiyor; KULE'nin PLAN_USER_ADDRESS adı (shared authz.ts) seçildi.
 */
import { http, isAddress, isAddressEqual, zeroAddress, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { parseDeployments, type Deployments } from "@pilot/shared";
import { ViemChainClient } from "./chainViem.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface PilotConfig {
  account: LocalAccount;
  user: Address;
  deployments: Deployments;
  rpcUrl: string;
  kuleUrl: string;
  kuleToken: string;
  /** INJECTION_DEMO=1: demo haber akışına gizli talimat eklenir; hiçbir kod korumasını kapatmaz (§10.5). */
  injectionDemo: boolean;
  replayPath: string | null;
}

function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} tanımlı değil`);
  return v;
}

export function loadPilotConfig(env: Record<string, string | undefined>, readText: (path: string) => string): PilotConfig {
  const pk = need(env, "PILOT_AGENT_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new ConfigError("PILOT_AGENT_PRIVATE_KEY biçimi geçersiz");
  let account: LocalAccount;
  try {
    account = privateKeyToAccount(pk as `0x${string}`);
  } catch {
    throw new ConfigError("PILOT_AGENT_PRIVATE_KEY geçersiz");
  }

  const user = need(env, "PLAN_USER_ADDRESS");
  if (!isAddress(user) || isAddressEqual(user, zeroAddress)) throw new ConfigError("PLAN_USER_ADDRESS geçerli bir adres değil");

  let deployments: Deployments;
  try {
    deployments = parseDeployments(readText(need(env, "DEPLOYMENTS")));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`DEPLOYMENTS okunamadı: ${(e as Error).message}`);
  }
  if (!isAddressEqual(account.address, deployments.pilotAgent)) {
    throw new ConfigError("PILOT_AGENT_PRIVATE_KEY'in adresi deployments.pilotAgent değil");
  }
  if (isAddressEqual(user, account.address) || isAddressEqual(user, deployments.kuleReporter)) {
    throw new ConfigError("PLAN_USER_ADDRESS ajan ya da KULE adresi olamaz");
  }

  const rpcUrl = need(env, "FUJI_RPC");
  if (!/^https?:\/\//.test(rpcUrl)) throw new ConfigError("FUJI_RPC http(s) URL olmalı");

  const injection = env.INJECTION_DEMO?.trim() ?? "0";
  if (injection !== "0" && injection !== "1" && injection !== "") throw new ConfigError("INJECTION_DEMO 0 ya da 1 olmalı");

  return {
    account,
    user,
    deployments,
    rpcUrl,
    kuleUrl: need(env, "KULE_URL"),
    kuleToken: need(env, "PILOT_TOKEN"),
    injectionDemo: injection === "1",
    replayPath: env.REPLAY?.trim() || null,
  };
}

/** Fuji (43113) istemcisi; deployments şeması başka zinciri zaten reddeder. */
export function chainClientFromConfig(c: PilotConfig): ViemChainClient {
  return new ViemChainClient({
    transport: http(c.rpcUrl),
    chain: avalancheFuji,
    account: c.account,
    flightPlan: c.deployments.flightPlan,
    user: c.user,
  });
}
