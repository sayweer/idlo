/**
 * Mutabakat komutu (§14): ortam + argüman → OKX (salt-okunur) + zincir → eşleştirme → Türkçe tablo → çıkış kodu.
 * Çıkış kodu: 0 ALARM yok, 1 ALARM var, 2 çalışamadı (fail-closed: okunamayan veri "temiz" sayılmaz).
 * Bütün ağ erişimi tek bir `fetch` üzerinden gider (test enjeksiyonu; M-1 anahtarın yalnız OKX'e gittiğini denetler).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { avalancheFuji } from "viem/chains";
import { daysToSec, MODE_LABELS, msToSec, parseDeployments, secToMs, type Deployments } from "@pilot/shared";
import { readChainSnapshot } from "./mutabakat-chain.js";
import { hasAlarm, MATCH_STATUS_TEXTS, MATCH_STATUSES, reconcile, type MatchRow } from "./mutabakat-match.js";
import { loadReadonlyCreds, OKX_ARCHIVE_DAYS, OKX_TR_BASE, OkxReadonlyClient } from "./okx-readonly.js";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_DEPLOYMENTS = resolve(REPO_ROOT, "deployments/fuji.json");
/** Ek B Fuji RPC (FUJI_RPC tanımlı değilse). */
export const FUJI_PUBLIC_RPC = "https://api.avax-test.network/ext/bc/C/rpc";
export const DEFAULT_DAYS = 7;

export interface MutabakatDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
  readText?: (path: string) => string;
  out?: (line: string) => void;
  /** eth_getLogs parça boyutu (test). */
  chunk?: bigint;
}

interface Args {
  days: number;
  demo: boolean;
  deployments: string;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const a: Args = { days: DEFAULT_DAYS, demo: false, deployments: DEFAULT_DEPLOYMENTS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--days") {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > OKX_ARCHIVE_DAYS) throw new UsageError(`--days 1–${OKX_ARCHIVE_DAYS} arası tamsayı olmalı`);
      a.days = Number(v);
    } else if (k === "--demo") {
      a.demo = true;
    } else if (k === "--deployments") {
      const v = argv[++i];
      if (!v) throw new UsageError("--deployments bir dosya yolu ister");
      a.deployments = resolve(v);
    } else {
      throw new UsageError(`bilinmeyen argüman: ${k}`);
    }
  }
  return a;
}

/** Sütunları hizalı düz metin tablo. */
export function formatTable(rows: MatchRow[]): string[] {
  const head = ["Durum", "İzin", "clOrdId", "ordId", "Zincir", "Borsa", "Not"];
  const body = rows.map((r) => [
    `${r.alarm ? "ALARM " : ""}${MATCH_STATUS_TEXTS[r.status]}`,
    r.actionId ?? "—",
    r.clOrdId ?? "—",
    r.ordId ?? "—",
    r.chain,
    r.exchange,
    r.note,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join(" │ ");
  return [line(head), widths.map((w) => "─".repeat(w)).join("─┼─"), ...body.map(line)];
}

export function summaryLines(rows: MatchRow[]): string[] {
  const counts = MATCH_STATUSES.map((s) => `${MATCH_STATUS_TEXTS[s]}: ${rows.filter((r) => r.status === s).length}`);
  const out = [`Özet — ${counts.join(" · ")}`];
  if (rows.some((r) => r.status === "EXCHANGE_ONLY")) {
    out.push("ALARM: Borsada zincirde izni olmayan emir var. Anahtarı hemen iptal et (OKX → API yönetimi).");
  }
  if (rows.some((r) => r.status === "MISMATCH")) {
    out.push("ALARM: Rapor ile borsadaki dolum ya da izin uyuşmuyor. KULE anahtarını iptal et ve kayıtları incele.");
  }
  if (!hasAlarm(rows)) out.push("ALARM yok: borsadaki her emir zincirdeki bir izne bağlı.");
  return out;
}

function readUser(env: Record<string, string | undefined>): Address {
  const v = env.USER?.trim();
  if (!v || !isAddress(v) || isAddressEqual(v, zeroAddress)) {
    throw new UsageError("USER Elif'in cüzdan adresi (0x…) olmalı; kabuğun USER değişkeni kullanıcı adıysa komutta USER=0x… ver");
  }
  return v;
}

export async function runMutabakat(d: MutabakatDeps): Promise<number> {
  const out = d.out ?? ((l: string) => console.log(l));
  const now = d.now ?? (() => new Date());
  const readText = d.readText ?? ((p: string) => readFileSync(p, "utf8"));

  let args: Args;
  let deployments: Deployments;
  let user: Address;
  let rpc: string;
  let okx: OkxReadonlyClient;
  try {
    args = parseArgs(d.argv);
    user = readUser(d.env);
    rpc = d.env.FUJI_RPC?.trim() || FUJI_PUBLIC_RPC;
    if (!/^https?:\/\//.test(rpc)) throw new UsageError("FUJI_RPC http(s) URL olmalı");
    let text: string;
    try {
      text = readText(args.deployments);
    } catch {
      throw new UsageError(`deployments dosyası okunamadı: ${args.deployments}`);
    }
    deployments = parseDeployments(text);
    okx = new OkxReadonlyClient(loadReadonlyCreds(d.env), { demo: args.demo, now, ...(d.fetch ? { fetch: d.fetch } : {}) });
  } catch (e) {
    out(`Mutabakat başlamadı: ${(e as Error).message}`);
    return 2;
  }

  out("═══ Mutabakat (§14) — Elif'in bilgisayarında, kendi salt-okunur OKX anahtarıyla ═══");
  out(`Etiket: ${args.demo ? `${MODE_LABELS.demo} (OKX demo hesabı)` : MODE_LABELS.live} · Kullanıcı ${user} · Son ${args.days} gün`);
  out(`Anahtar yalnız ${OKX_TR_BASE} adresine imzalı GET başlığı olarak gider; gizli anahtar (secret) hiçbir yere gönderilmez.`);

  try {
    await okx.assertReadOnly();
    out("OKX anahtarı salt-okunur (trade ve withdraw yetkisi yok).");

    const pub = createPublicClient({ chain: avalancheFuji, transport: http(rpc, d.fetch ? { fetchFn: d.fetch } : {}) });
    const snapshot = await readChainSnapshot(pub, {
      flightPlan: deployments.flightPlan,
      user,
      fromBlock: BigInt(deployments.deployBlock),
      expectedChainId: deployments.chainId,
      ...(d.chunk ? { chunk: d.chunk } : {}),
    });
    out(`Zincir: FlightPlan ${deployments.flightPlan}, blok ${deployments.deployBlock}–${snapshot.head}: ` +
      `${snapshot.authorized.length} izin, ${snapshot.executed.length} rapor.`);

    const endMs = now().getTime();
    const beginMs = endMs - secToMs(daysToSec(args.days));
    const orders = await okx.listOrders({ beginMs, endMs, days: args.days });
    out(`Borsa: USDT-TRY, ${orders.length} emir (açık + geçmiş).`);

    const rows = reconcile({ snapshot, orders, windowStartSec: msToSec(beginMs) });
    out("");
    if (rows.length === 0) out("Pencerede izin de emir de yok.");
    else for (const l of formatTable(rows)) out(l);
    out("");
    for (const l of summaryLines(rows)) out(l);
    return hasAlarm(rows) ? 1 : 0;
  } catch (e) {
    out(`Mutabakat tamamlanamadı (sonuç yok; bu temiz sonuç sayılmaz): ${(e as Error).message}`);
    return 2;
  }
}
