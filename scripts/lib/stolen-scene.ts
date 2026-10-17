/**
 * "Ajan anahtarı çalındı" sahnesi (§10.5, §16 #19, E-4, §19 4:30–6:30): saf akış + Türkçe sahne metni.
 * Zincir ve KULE arayüzle enjekte edilir (gerçek: stolen-io.ts; test: sahte).
 *
 * Akış:
 *  1. Ön kontrol (yalnız okuma): anahtar deployments.pilotAgent mı, Elif'in planı bu ajana mı bağlı, plan etkin ve
 *     pencere içinde mi, 40.000 TL plan tavanını aşıyor mu, eth_call 0 (ret) döndürüyor mu. Biri tutmazsa işlem
 *     GÖNDERİLMEZ (fail-closed). Bu betik asla gerçek bir izin oluşturmaz: tavan 40.000'e izin veriyorsa durur.
 *  2. PİLOT'un anahtarıyla, LLM ve araç katmanı olmadan, doğrudan requestBuy(Elif, 40.000 TL). Kontrat
 *     BuyRejected(OVER_ORDER_LIMIT) yayar; Fuji'de Snowtrace bağlantısı basılır.
 *  3. Var olmayan izin numarasıyla KULE'den emir: canlı KULE (KULE_URL + PILOT_TOKEN varsa) ya da çevrimdışı
 *     KULE kontrolü (packages/shared authz.ts checkActionOwner, KULE'nin kullandığı fonksiyon) → RET NO_AUTHORIZATION.
 *  4. Yabancı plan varyantı (contracts/test/AuthBinding.t.sol), çevrimdışı: saldırganın kendi planı üzerinden alınmış
 *     izin KULE bağında düşer (kendi ajanı → WRONG_AGENT; gerçek PİLOT adresi → NO_AUTHORIZATION). Zincire işlem yok.
 */
import { isAddressEqual, keccak256, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import {
  checkActionOwner,
  formatTL,
  kuleReasonText,
  ordTypeToChain,
  rejectCodeName,
  REJECT_TEXTS,
  RejectCode,
  STOLEN_KEY_MESSAGE,
  tlFromChain,
  type ChainBuyAction,
  type ChainPlan,
  type Deployments,
  type KuleBinding,
  type KuleReasonCode,
} from "@pilot/shared";

/** §10.5: "tüm TL" (40.000). */
export const STOLEN_AMOUNT_TL = 40_000;
/** Bant kapalıyken fiyatın ret koduna etkisi yok; 3 numaralı kod tutardan gelir. pxE6 = 50,00 TL. */
export const STOLEN_MAX_PX_E6 = 50_000_000;
export const STOLEN_ORD_TYPE = "ioc" as const;
export const STOLEN_REASON_HASH: Hex = keccak256(stringToHex("PILOT stolen-key sahnesi (SPEC 10.5)"));
/** Var olmayan izin numarası: lastActionId + bu fark (ayrıca zincirde boş olduğu doğrulanır). */
export const FAKE_ACTION_OFFSET = 1_000_000n;
/** Yabancı plan varyantındaki örnek saldırgan adresleri (yalnız gösterim; zincirde işlem yok). */
export const DEMO_ATTACKER: Address = "0x000000000000000000000000000000000000a77a";
export const DEMO_ATTACKER_AGENT: Address = "0x000000000000000000000000000000000000ba5e";

export const SNOWTRACE_FUJI = "https://testnet.snowtrace.io";

export type SceneNetwork = "fuji" | "local";

export interface RequestBuyCall {
  user: Address;
  amountTL: bigint;
  maxPxE6: bigint;
  ordType: number;
  reasonHash: Hex;
}

export type SentResult =
  | { kind: "rejected"; hash: Hex; user: Address; amountTL: bigint; code: number }
  | { kind: "authorized"; hash: Hex; actionId: bigint }
  | { kind: "other"; hash: Hex };

/** Sahnenin zincirden istediği (gerçek: viem; test: sahte). */
export interface StolenChain {
  /** Anahtarın adresi (PİLOT_AGENT). */
  readonly agent: Address;
  chainId(): Promise<number>;
  plan(user: Address): Promise<ChainPlan>;
  isPlanActive(user: Address): Promise<boolean>;
  trDay(): Promise<number>;
  lastActionId(): Promise<bigint>;
  action(id: bigint): Promise<ChainBuyAction>;
  /** eth_call: dönüş değeri (actionId; 0 = ret). Revert'te fırlatır. */
  simulateRequestBuy(c: RequestBuyCall): Promise<bigint>;
  /** İşlemi gönderir, makbuzu bekler, FlightPlan olayını çözer. */
  sendRequestBuy(c: RequestBuyCall): Promise<SentResult>;
}

/** Canlı KULE (MCP kule_execute) yanıtının sahne için gereken kısmı. */
export interface KuleExecuteProbe {
  execute(actionId: string): Promise<{ verdict: string; reasons: string[] }>;
}

export interface SceneInput {
  chain: StolenChain;
  network: SceneNetwork;
  deployments: Deployments;
  user: Address;
  kule?: KuleExecuteProbe;
  out: (line: string) => void;
}

export interface SceneResult {
  ok: boolean;
  sent: boolean;
  tx?: Hex;
  rejectCode?: number;
  fakeActionId?: string;
  kuleVerdict?: { verdict: string; reasons: string[]; live: boolean };
  foreign?: { ownAgent: string; realAgent: string };
}

export class SceneAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneAbort";
  }
}

export function snowtraceTx(hash: Hex): string {
  return `${SNOWTRACE_FUJI}/tx/${hash}`;
}

/** KULE'nin kendi yapılandırması: yapılandırılmış kullanıcı Elif, KULE_REPORTER, PILOT_TOKEN → pilotAgent. */
export function kuleBindingOf(d: Deployments, user: Address): KuleBinding {
  return { planUser: user, kuleReporter: d.kuleReporter, tokenAgent: d.pilotAgent };
}

function reasonLine(code: string): string {
  try {
    return `${code} — ${kuleReasonText(code as KuleReasonCode)}`;
  } catch {
    return code;
  }
}

/**
 * Yabancı plan varyantı (AuthBinding.t.sol), çevrimdışı. Saldırgan kendi adresine plan kurar ve plana gerçek KULE'yi
 * yazar; zincirde AUTHORIZED bir izin oluşur. KULE'nin bağı (checkActionOwner) bunu reddeder.
 */
export function foreignPlanVerdicts(binding: KuleBinding, d: Deployments): { ownAgent: string; realAgent: string } {
  const action = { user: DEMO_ATTACKER };
  const ownAgent = checkActionOwner(action, { agent: DEMO_ATTACKER_AGENT, kule: d.kuleReporter }, binding);
  const realAgent = checkActionOwner(action, { agent: d.pilotAgent, kule: d.kuleReporter }, binding);
  return {
    ownAgent: ownAgent.ok ? "ONAY" : ownAgent.reason,
    realAgent: realAgent.ok ? "ONAY" : realAgent.reason,
  };
}

export async function runStolenKeyScene(i: SceneInput): Promise<SceneResult> {
  const { chain, deployments: d, user, out } = i;
  const res: SceneResult = { ok: false, sent: false };

  out("════════ Sahne: Ajan anahtarı çalındı (SPEC §10.5) ════════");
  out(i.network === "fuji" ? "Etiket: CANLI · Avalanche Fuji" : "Etiket: YEREL · Anvil (gerçek ağ değil; Snowtrace bağlantısı yok)");
  out(`Saldırgan PİLOT'un kendi anahtarını ele geçirdi: ${chain.agent}`);
  out(`LLM yok, araç katmanı yok: doğrudan FlightPlan.requestBuy(Elif, ${formatTL(STOLEN_AMOUNT_TL)} TL) gönderiliyor.`);
  out("");

  // ── 1. Ön kontrol (yalnız okuma) ──
  const chainId = await chain.chainId();
  if (chainId !== d.chainId) throw new SceneAbort(`RPC zinciri ${chainId}, deployments ${d.chainId}; işlem gönderilmedi`);
  if (!isAddressEqual(chain.agent, d.pilotAgent)) {
    throw new SceneAbort("anahtarın adresi deployments.pilotAgent değil; sahne PİLOT'un kendi anahtarıyla oynanır");
  }
  if (isAddressEqual(user, d.pilotAgent) || isAddressEqual(user, d.kuleReporter) || isAddressEqual(user, zeroAddress)) {
    throw new SceneAbort("PLAN_USER_ADDRESS Elif'in adresi olmalı");
  }
  const plan = await chain.plan(user);
  if (isAddressEqual(plan.agent, zeroAddress)) throw new SceneAbort("Elif'in planı yok; önce planı imzala (setPlan)");
  if (!isAddressEqual(plan.agent, chain.agent)) throw new SceneAbort("Elif'in planı bu ajana bağlı değil (plan.agent farklı)");
  if (!(await chain.isPlanActive(user))) throw new SceneAbort("Elif'in planı etkin değil; sahne kod 1 gösterirdi");
  const day = await chain.trDay();
  if (day < plan.startDay || day > plan.deadlineDay) {
    throw new SceneAbort(`bugün (TR günü ${day}) plan penceresi (${plan.startDay}–${plan.deadlineDay}) dışında; sahne kod 2 gösterirdi`);
  }
  const maxOrderTL = tlFromChain(plan.maxOrderTL);
  if (maxOrderTL >= STOLEN_AMOUNT_TL) {
    throw new SceneAbort(`planın tek emir tavanı ${formatTL(maxOrderTL)} TL; ${formatTL(STOLEN_AMOUNT_TL)} TL reddedilmez. Betik gerçek izin oluşturmaz`);
  }
  out(`1) Elif'in imzaladığı plan: tek emir en çok ${formatTL(maxOrderTL)} TL, ayda ${formatTL(tlFromChain(plan.cycleTL))} TL, ` +
    `gün ${plan.startDay}–${plan.deadlineDay} (bugün ${day}).`);

  const call: RequestBuyCall = {
    user,
    amountTL: BigInt(STOLEN_AMOUNT_TL),
    maxPxE6: BigInt(STOLEN_MAX_PX_E6),
    ordType: ordTypeToChain(STOLEN_ORD_TYPE),
    reasonHash: STOLEN_REASON_HASH,
  };
  const simulated = await chain.simulateRequestBuy(call);
  if (simulated !== 0n) throw new SceneAbort(`eth_call izin numarası ${simulated} döndürdü; ret beklenmiyor, işlem gönderilmedi`);
  out("   Ön kontrol (eth_call): kontrat 0 döndürüyor, yani reddedecek. İşlem gönderiliyor…");

  // ── 2. requestBuy ──
  const sent = await chain.sendRequestBuy(call);
  res.sent = true;
  res.tx = sent.hash;
  out(`2) İşlem zincirde: ${sent.hash}`);
  if (i.network === "fuji") out(`   Snowtrace: ${snowtraceTx(sent.hash)}`);
  let chainOk = false;
  if (sent.kind === "rejected") {
    res.rejectCode = sent.code;
    let name = `kod ${sent.code}`;
    let text = "";
    try {
      const n = rejectCodeName(sent.code);
      name = `kod ${sent.code} ${n}`;
      text = REJECT_TEXTS[n];
    } catch {
      /* bilinmeyen kod: adsız basılır */
    }
    out(`   Sonuç: BuyRejected — ${name}${text ? `: "${text}"` : ""}`);
    chainOk = sent.code === RejectCode.OVER_ORDER_LIMIT && isAddressEqual(sent.user, user) && sent.amountTL === call.amountTL;
    if (!chainOk) out("   UYARI: beklenen ret OVER_ORDER_LIMIT (kod 3) değil.");
  } else if (sent.kind === "authorized") {
    out(`   ALARM: kontrat izin verdi (actionId ${sent.actionId})! Elif planı hemen iptal etmeli (revoke).`);
  } else {
    out("   UYARI: makbuzda BuyRejected olayı bulunamadı.");
  }
  out("");

  // ── 3. Sahte izin numarasıyla KULE ──
  const fakeId = (await chain.lastActionId()) + FAKE_ACTION_OFFSET;
  res.fakeActionId = fakeId.toString();
  const fakeAction = await chain.action(fakeId);
  if (!isAddressEqual(fakeAction.user, zeroAddress)) throw new SceneAbort(`izin ${fakeId} zincirde var; sahte numara seçilemedi`);
  out(`3) Aynı ajan, var olmayan izin numarasıyla KULE'den emir istiyor: kule_execute {actionId: ${fakeId}}`);
  let kuleOk = false;
  if (i.kule) {
    const r = await i.kule.execute(fakeId.toString());
    res.kuleVerdict = { ...r, live: true };
    out(`   KULE (canlı): ${r.verdict} ${r.reasons.map(reasonLine).join(", ")}`);
    kuleOk = r.verdict === "RET" && r.reasons.includes("NO_AUTHORIZATION");
  } else {
    const binding = kuleBindingOf(d, user);
    const plan0 = await chain.plan(fakeAction.user);
    const v = checkActionOwner(fakeAction, plan0, binding);
    const verdict = v.ok ? "ONAY" : v.verdict;
    const reasons = v.ok ? [] : [v.reason];
    res.kuleVerdict = { verdict, reasons, live: false };
    out("   KULE_URL/PILOT_TOKEN yok: ÇEVRİMDIŞI KULE kontrolü (packages/shared authz.ts, KULE ile aynı fonksiyon; zincirden okundu).");
    out(`   KULE: ${verdict} ${reasons.map(reasonLine).join(", ")}`);
    kuleOk = verdict === "RET" && reasons.includes("NO_AUTHORIZATION");
  }
  if (!kuleOk) out("   UYARI: beklenen RET NO_AUTHORIZATION değil.");
  out("");

  // ── 4. Yabancı plan varyantı (çevrimdışı) ──
  const foreign = foreignPlanVerdicts(kuleBindingOf(d, user), d);
  res.foreign = foreign;
  out("4) Başka bir plan üzerinden deneme (contracts/test/AuthBinding.t.sol) — ÇEVRİMDIŞI, zincire işlem gönderilmedi:");
  out(`   a) Saldırgan kendi adresine plan kurar, plana kendi ajanını ve gerçek KULE'yi yazar; zincir izni verir.`);
  out(`      KULE: RET ${reasonLine(foreign.ownAgent)}`);
  out(`   b) Saldırgan planına gerçek PİLOT adresini yazar; çalınmış anahtarla izin alır.`);
  out(`      KULE: RET ${reasonLine(foreign.realAgent)} (izin Elif'in değil)`);
  const foreignOk = foreign.ownAgent === "WRONG_AGENT" && foreign.realAgent === "NO_AUTHORIZATION";
  if (!foreignOk) out("   UYARI: KULE bağı yabancı planı reddetmedi.");
  out("");

  res.ok = chainOk && kuleOk && foreignOk;
  out(res.ok ? `Mesaj: ${STOLEN_KEY_MESSAGE}` : "Sahne beklenen sonucu vermedi; yukarıdaki uyarılara bak.");
  return res;
}
