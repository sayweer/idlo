import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddressEqual, parseEventLogs, type Address, type Hex } from "viem";
import {
  applyEdit,
  buildPlanConfirmation,
  CONFIRM_BADGES_TR,
  CONFIRM_TITLE_TR,
  cycleIdOf,
  cycleIdParts,
  deadlineEndSec,
  formatDecimalTr,
  formatTL,
  PLAN_FIELD_LABELS_TR,
  PLAN_FIELDS,
  planToChain,
  scaledToDecimal,
  trParts,
  type Cycle,
  type EditablePlanField,
  type Plan,
  type PlanConfirmation,
  type PlanDraft,
  type PlanField,
} from "@pilot/shared";
import { deploymentsOf, useChainReads, useDeployments, type ChainReads } from "../lib/data";
import { FLIGHT_PLAN_ABI } from "../lib/flightPlanAbi";
import { short } from "../lib/format";
import { explorerAddress, explorerTx } from "../lib/fuji";
import { useFujiGuard, useTx } from "../lib/tx";
import "../styles/yetkiler.css";
import { Shell } from "./Shell";
import { OnFuji } from "./Wallet";
import type { BadgeKind } from "./Badges";

// ── metinler ────────────────────────────────────────────────────────────
// Ekranın kendi metinleri. Ret/hata/alan adı metinleri @pilot/shared'dedir (PLAN_FIELD_LABELS_TR, CONFIRM_*, rejectText …).
const TXT = {
  label: "Yetkiler",
  title: "Sınırın senin elinde.",
  lede: "Sınırı düşürmek anında geçer, yükseltmek 24 saat bekler. İstediğin an her şeyi durdurabilirsin.",
  chain: "Bu ekran Fuji'deki Uçuş Planı kontratından okur; hiçbir şey tahmin edilmez.",
  connect: "Cüzdanını bağla",
  connectBody: "Planını görmek için cüzdanını panoya iğnele. Soldaki kutudan bağlanabilirsin.",
  noDeploy: "Kontrat henüz dağıtılmadı",
  noDeployBody: "deployments/fuji.json gelene kadar planın okunamaz ve imza kapalıdır.",
  badDeploy: "Kontrat adresi okunamadı",
  readFail: "Zincir okunamadı",
  readFailBody: "Plan bilgisi gelmedi; gri bir ekran 'sorun yok' demek değildir. Hiçbir şey imzalanmadı.",
  retry: "Tekrar dene",
  noPlan: "Zincirde planın yok",
  noPlanBody: "Önce bir ajan seç ve Uçuş Planı'nı imzala. Plan kurulunca sınırlarını burada yönetirsin.",
  choose: "Ajan seç",
  planLabel: "Zincirdeki plan",
  active: "Etkin",
  inactive: "Plan etkin değil",
  expiredWord: "Süresi doldu.",
  revokedWord: "Durduruldu.",
  inactiveNote:
    "Bu «plan yok» değildir: üstüne kurulan daha gevşek plan 24 saat bekler; daha sıkı olanı anında geçer ve planı yeniden etkinleştirir.",
  editLabel: "Sınırları düzenle",
  editLede: "Form zincirdeki plandan başlar. PİLOT/ajan, KULE, kimlik, fiyat bandı ve bitiş tarihi aynen korunur.",
  expiresField: "Bitişi değiştir (bugünden itibaren gün)",
  expiresHint: "Boş bırakırsan bitiş aynen kalır. Uzatmak her zaman gevşemedir ve 24 saat bekler.",
  deadlineNote: "Son günü değiştirmek her zaman 24 saat bekler (daha erken olsa bile).",
  predict: "Tahmin",
  predictNote: "Bu yalnız bir tahmindir; gerçek sonuç imzadan sonra kontratın PlanSet olayından gösterilir.",
  lower: "Sınırı düşür — anında geçer",
  raise: "Sınırı yükselt — 24 saat bekler; eski plan o zamana kadar geçerli",
  raiseInactive: "Planı güncelle — 24 saat bekler",
  noChange: "Değişiklik yok",
  reset: "Sıfırla",
  buildFail: "Düzenleme penceresi kurulamadı; imza kapalı.",
  drift: "Bu plan düzenleme penceresiyle aynen korunamıyor; imza kapalı. Değişmesi gereken alanlar:",
  confirmTitle: CONFIRM_TITLE_TR,
  confirmLede: "Aşağıdaki değerlerin tamamı zincire yazılır; burada görünmeyen hiçbir değer yazılmaz.",
  sign: "İmzala",
  cancel: "Vazgeç",
  pendingLabel: "Bekleyen plan",
  pendingWarnTitle: "Bekleyen daha gevşek bir plan var",
  pendingWarnBody: "Bunu sen kurmadıysan «Her şeyi durdur». Süre dolunca plan sessizce devreye girer.",
  pendingActivates: "Devreye girer",
  pendingLeft: "kalan",
  pendingReady: "Süre doldu: herkes devreye alabilir.",
  commit: "Şimdi devreye al",
  colField: "Alan",
  colActive: "Etkin plan",
  colPending: "Bekleyen plan",
  stopLabel: "Her şeyi durdur",
  stopBody: "Plan hemen etkisiz olur ve bekleyen plan silinir. Elif'in imzası dışında hiçbir şey yeniden başlatamaz.",
  stopBtn: "Her şeyi durdur",
  stopConfirmTitle: "Her şeyi durdur?",
  stopConfirmList: [
    "Plan hemen etkisiz olur; ajan yeni izin alamaz.",
    "Bekleyen plan varsa silinir.",
    "Verilmiş izinleri KULE düşürür.",
    "Üstüne kuracağın daha gevşek plan 24 saat bekler.",
  ],
  stopYes: "Evet, her şeyi durdur",
  stopped: "Her şey durduruldu: plan etkin değil.",
  pendingCleared: "Bekleyen gevşek plan silindi — 24 saat sonra sessizce devreye girmeyecek.",
  cycleLabel: "Bu ayın döngüsü",
  cycleNone: "Bu ay için henüz döngü açılmadı.",
  spent: "Harcanan",
  reserved: "Açık izinlerde ayrılan",
  closedWord: "Kapalı",
  openWord: "Açık",
  closeCycle: "Döngüyü kapat",
  scan: "Süresi dolan izinleri tara",
  scanning: "Taranıyor…",
  scanNone: "Süresi dolup açık kalmış izin yok.",
  scanFail: "İzin geçmişi okunamadı.",
  expireOne: "İzni düşür",
  expireHint: "Rapor süresi geçmiş izinler ayrılan tutarı tutar; düşürülene kadar yeni istekler reddedilir.",
  helpLabel: "Nasıl işler",
  help: [
    "Düşürmek ya da aynı bırakmak anında geçer.",
    "Yükseltmek 24 saat bekler; bu sürede eski plan geçerli kalır.",
    "Her şeyi durdur hemen etkilidir ve bekleyeni de siler.",
    "İmza yalnız onay penceresinden atılır.",
  ],
  demoNote: "Örnek plan: zincirden okunmadı, imza kapalı.",
  resultLabel: "Sonuç",
};

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

// ── biçim ───────────────────────────────────────────────────────────────
const pad2 = (n: number) => String(n).padStart(2, "0");
/** "18.10.2026 14:05 (TR saati)": saatler her yerde TR saatidir. */
const fmtDate = (sec: number) => {
  const p = trParts(sec);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year} ${pad2(p.hour)}:${pad2(p.minute)} (TR saati)`;
};
const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};
const fmtTL = (n: number) => `${formatTL(n)} TL`;
const bps = (v: number) => (v === 0 ? "Kapalı" : `%${formatDecimalTr(scaledToDecimal(BigInt(v), 2), 2)}`);
/** "X,X sn'de kesinleşti": msToSec tamsayıya keser, bu yüzden ondalık biçim (UI_HANDOFF §2). */
const fmtFinality = (ms: number) => `${formatDecimalTr(scaledToDecimal(BigInt(ms), 3), 1)} sn'de kesinleşti · gönderimden makbuza`;

/**
 * Alanların Türkçe gösterimi. TODO(spec): shared'in `display()`'i dışa açık değil; `planDisplayTr(plan)` olarak shared'e taşınmalı.
 * Onay penceresinin satırları (`rows.displayTr`) shared'den gelir; bu yalnız plan/bekleyen tabloları içindir.
 */
function cellsOf(p: Plan): Record<PlanField, string> {
  return {
    cycleTL: fmtTL(p.cycleTL),
    maxOrderTL: fmtTL(p.maxOrderTL),
    startDay: `Ayın ${p.startDay}. günü`,
    deadlineDay: `Ayın ${p.deadlineDay}. günü sonuna kadar`,
    maxWaitH: `${formatDecimalTr(String(p.maxWaitH), 0)} saat`,
    bandBps: bps(p.bandBps),
    closedBandBps: bps(p.closedBandBps),
    askMode: p.askMode === 1 ? "Evet, emin olmazsa sana sorar" : "Hayır, sormadan karar verir",
    expiresAt: fmtDate(p.expiresAt),
    agent: p.agent,
    kule: p.kule,
    agentId: `#${p.agentId}`,
  };
}

const isAddressField = (f: PlanField) => f === "agent" || f === "kule";
function Cell({ field, value }: { field: PlanField; value: string }) {
  if (isAddressField(field)) {
    return <a href={explorerAddress(value)} target="_blank" rel="noopener noreferrer">{short(value)} ↗</a>;
  }
  return <>{value}</>;
}

// ── zincirden okunan görünüm ────────────────────────────────────────────
interface View {
  plan: Plan | null;
  active: boolean;
  pending: { plan: Plan; activeAt: number } | null;
  cycle: Cycle;
}

type Preview = "aktif" | "bekleyen" | "iptal" | "yok";
const PREVIEW_USER = "0x3333333333333333333333333333333333333333" as Address;

/** Yalnız `vite dev` ve ?onizleme=… ile açılır (üretim derlemesinde yok): DEMO PLANI etiketli örnek veri, imza kapalı. */
function previewOf(raw: string | null): Preview | null {
  if (!import.meta.env.DEV || raw === null) return null;
  return raw === "bekleyen" || raw === "iptal" || raw === "yok" ? raw : "aktif";
}

function sampleView(kind: Preview): View {
  const now = Math.floor(Date.now() / 1000);
  const plan: Plan = {
    cycleTL: 20000, maxOrderTL: 10000, startDay: 1, deadlineDay: 5, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
    expiresAt: now + 60 * 86400,
    agent: "0x1111111111111111111111111111111111111111",
    kule: "0x2222222222222222222222222222222222222222",
    agentId: "7",
  };
  const cycle: Cycle = { id: cycleIdOf(now), spentTL: 10000, reservedTL: 0, closed: false };
  if (kind === "yok") return { plan: null, active: false, pending: null, cycle: { id: 0, spentTL: 0, reservedTL: 0, closed: false } };
  if (kind === "iptal") return { plan, active: false, pending: null, cycle };
  if (kind === "bekleyen") {
    return { plan, active: true, pending: { plan: { ...plan, cycleTL: 40000, maxOrderTL: 20000, deadlineDay: 12 }, activeAt: now + 5 * 3600 + 23 * 60 }, cycle };
  }
  return { plan, active: true, pending: null, cycle };
}

function useNowSec() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── düzenleme penceresi (shared'in buildPlanConfirmation / applyEdit'i) ──
interface Form {
  cycleTL: string;
  maxOrderTL: string;
  startDay: string;
  deadlineDay: string;
  maxWaitH: string;
  askOnAmbiguity: "1" | "0";
  expiresDays: string;
}
const formOf = (p: Plan): Form => ({
  cycleTL: String(p.cycleTL),
  maxOrderTL: String(p.maxOrderTL),
  startDay: String(p.startDay),
  deadlineDay: String(p.deadlineDay),
  maxWaitH: String(p.maxWaitH),
  askOnAmbiguity: p.askMode === 1 ? "1" : "0",
  expiresDays: "",
});

/** Zincirdeki plandan taslak. `expiresInDays` varsayılan kalır: mevcut plan sürüyorsa shared bitişi aynen korur (kırpar). */
const draftOf = (p: Plan): PlanDraft => ({
  cycleTL: { value: p.cycleTL, source: "user" },
  startDay: { value: p.startDay, source: "user" },
  deadlineDay: { value: p.deadlineDay, source: "user" },
  maxOrderTL: { value: p.maxOrderTL, source: "user" },
  askOnAmbiguity: { value: p.askMode === 1, source: "user" },
  maxWaitH: { value: p.maxWaitH, source: "user" },
  expiresInDays: { value: 90, source: "default" },
  questions: [],
});

const EDIT_FIELD: Record<keyof Form, EditablePlanField> = {
  cycleTL: "cycleTL",
  maxOrderTL: "maxOrderTL",
  startDay: "startDay",
  deadlineDay: "deadlineDay",
  maxWaitH: "maxWaitH",
  askOnAmbiguity: "askMode",
  expiresDays: "expiresAt",
};

/**
 * Pencere zincirdeki plandan kurulur: ajan, KULE ve kimlik dağıtım dosyasından değil mevcut plandan alınır (aynen korunur).
 * TODO(spec): shared'e `buildPlanEdit(current, edits, ctx)` olarak taşınmalı; burada yalnız shared'in iki saf fonksiyonu çağrılır
 * ve kilitli alanların aynen korunduğu `lockDrift` ile ayrıca doğrulanır (kural 2: emin değilsen imza kapalı).
 */
function buildEdited(plan: Plan, active: boolean, form: Form, nowSec: number): PlanConfirmation {
  let conf = buildPlanConfirmation(draftOf(plan), {
    nowSec,
    deployments: { pilotAgent: plan.agent, kuleReporter: plan.kule, agentId: plan.agentId },
    current: plan,
    currentActive: active,
  });
  const init = formOf(plan);
  for (const k of Object.keys(EDIT_FIELD) as (keyof Form)[]) {
    if (form[k] === init[k]) continue;
    if (k === "expiresDays" && form[k].trim() === "") continue;
    conf = applyEdit(conf, EDIT_FIELD[k], k === "askOnAmbiguity" ? form[k] === "1" : form[k]);
  }
  return conf;
}

/** Kilitli alanlar (ajan, KULE, kimlik, bantlar, düzeltilmedikçe bitiş) pencerede mevcut plandan farklıysa etiketleri döner. */
function lockDrift(conf: PlanConfirmation, current: Plan, expiresEdited: boolean): string[] {
  const want = planToChain(current);
  const locked: PlanField[] = ["agent", "kule", "agentId", "bandBps", "closedBandBps", ...(expiresEdited ? [] : (["expiresAt"] as PlanField[]))];
  return locked
    .filter((f) => {
      const row = conf.rows.find((r) => r.field === f);
      return !row || row.chainValue === null || row.chainValue.toLowerCase() !== String(want[f]).toLowerCase();
    })
    .map((f) => PLAN_FIELD_LABELS_TR[f]);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── işlemler ────────────────────────────────────────────────────────────
interface Outcome {
  title: string;
  lines: string[];
  hash: Hex;
  finalityMs: number;
}
type SendArgs = Parameters<ReturnType<typeof useTx>["send"]>[1];
type Call = { functionName: "setPlan" | "commitPending" | "revoke" | "expireAction" | "closeCycle"; args: readonly unknown[] };
type Run = (label: string, call: Call, describe?: (events: ReturnType<typeof flightEvents>) => string[]) => Promise<boolean>;

function flightEvents(logs: readonly { address: Address }[], flightPlan: Address) {
  return parseEventLogs({
    abi: FLIGHT_PLAN_ABI,
    logs: (logs as Parameters<typeof parseEventLogs>[0]["logs"]).filter((l) => isAddressEqual(l.address, flightPlan)),
  });
}
type Events = ReturnType<typeof flightEvents>;
const hasEvent = (ev: Events, name: string) => ev.some((e) => e.eventName === name);

/** setPlan sonucu PlanSet.immediate'ten gösterilir (UI tahmini değil). */
function describeSetPlan(ev: Events): string[] {
  const set = ev.find((e) => e.eventName === "PlanSet");
  const lines: string[] = [];
  if (!set || set.eventName !== "PlanSet") lines.push("PlanSet olayı okunamadı; planın durumunu zincirden kontrol et.");
  else if (set.args.immediate) lines.push("Plan anında geçti.");
  else lines.push(`Plan 24 saat bekliyor: ${fmtDate(Number(set.args.activeAt))} devreye girer. O zamana kadar eski plan geçerli.`);
  if (hasEvent(ev, "PendingCleared")) lines.push(TXT.pendingCleared);
  return lines;
}

function useActions(flightPlan: Address | null, canSign: boolean, onDone: () => void) {
  const { send, busy } = useTx();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run: Run = useCallback(
    async (label, call, describe) => {
      if (!flightPlan || !canSign) return false;
      const r = await send(label, { address: flightPlan, abi: FLIGHT_PLAN_ABI, functionName: call.functionName, args: call.args } as SendArgs);
      if (!r) return false;
      const ev = flightEvents(r.receipt.logs, flightPlan);
      setOutcome({ title: label, lines: describe ? describe(ev) : [], hash: r.hash, finalityMs: r.finalityMs });
      onDone();
      return true;
    },
    [flightPlan, canSign, send, onDone],
  );
  return { run, busy, outcome, clearOutcome: () => setOutcome(null) };
}

// ── küçük bileşenler ────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ykt-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="card no-pin ykt-modal-card" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function StateCard({ label, title, body, children }: { label: string; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="card tilt-l no-pin" role="status">
      <div className="label">{label}</div>
      <h2 className="h3" style={{ marginTop: 8 }}>{title}</h2>
      {body && <p className="note" style={{ marginTop: 10 }}>{body}</p>}
      {children && <div className="row" style={{ marginTop: 16 }}>{children}</div>}
    </div>
  );
}

function PlanTable({ plan, active, now }: { plan: Plan; active: boolean; now: number }) {
  const cells = cellsOf(plan);
  return (
    <>
      <div className="between" style={{ flexWrap: "wrap" }}>
        <span className="label">{TXT.planLabel}</span>
        <span className={`chip ${active ? "paid" : ""}`}>{active ? TXT.active : TXT.inactive}</span>
      </div>
      {!active && (
        <div className="ykt-note" role="note">
          <b>{plan.expiresAt <= now ? TXT.expiredWord : TXT.revokedWord}</b> {TXT.inactiveNote}
        </div>
      )}
      <table className="simple ykt-table" style={{ marginTop: 12 }}>
        <tbody>
          {PLAN_FIELDS.map((f) => (
            <tr key={f}>
              <th scope="row">{PLAN_FIELD_LABELS_TR[f]}</th>
              <td><Cell field={f} value={cells[f]} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Field({ label, children, error, note }: { label: string; children: ReactNode; error?: string | null; note?: string | null }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {error && <span className="hint ykt-err">{error}</span>}
      {!error && note && <span className="hint">{note}</span>}
    </label>
  );
}

// ── düzenleme formu + onay penceresi ────────────────────────────────────
function PlanEditor({ view, plan, canSign, run, busy }: { view: View; plan: Plan; canSign: boolean; run: Run; busy: boolean }) {
  const [form, setForm] = useState<Form>(() => formOf(plan));
  const [anchor] = useState(() => Math.floor(Date.now() / 1000));
  const [confirm, setConfirm] = useState<{ conf: PlanConfirmation; drift: string[] } | null>(null);
  const init = useMemo(() => formOf(plan), [plan]);
  const changed = (Object.keys(init) as (keyof Form)[]).some((k) => form[k] !== init[k] && !(k === "expiresDays" && form[k].trim() === ""));
  const expiresEdited = form.expiresDays.trim() !== "";

  const model = useMemo(() => {
    try {
      const conf = buildEdited(plan, view.active, form, anchor);
      return { conf, drift: lockDrift(conf, plan, expiresEdited), error: null as string | null };
    } catch (e) {
      return { conf: null, drift: [] as string[], error: errMsg(e) };
    }
  }, [plan, view.active, form, anchor, expiresEdited]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const row = (f: PlanField) => model.conf?.rows.find((r) => r.field === f);
  const rowFor = (k: keyof Form) => {
    const r = row(EDIT_FIELD[k]);
    const touched = form[k] !== init[k];
    return { error: touched ? r?.error : null, note: touched ? r?.note : null };
  };
  const conf = model.conf;
  const immediate = conf?.activation?.immediate ?? false;
  const sendLabel = immediate ? TXT.lower : view.active ? TXT.raise : TXT.raiseInactive;
  const ready = canSign && changed && conf !== null && conf.signable && model.drift.length === 0;

  const open = () => {
    // imza anındaki saatle yeniden kur: pencere ne gösteriyorsa yazılan odur
    try {
      const fresh = buildEdited(plan, view.active, form, Math.floor(Date.now() / 1000));
      setConfirm({ conf: fresh, drift: lockDrift(fresh, plan, expiresEdited) });
    } catch (e) {
      setConfirm(null);
      console.error(e);
    }
  };

  const sign = async () => {
    const args = confirm?.conf.setPlanArgs;
    if (!confirm || !args || confirm.drift.length > 0) return;
    const ok = await run("Planı güncelle", { functionName: "setPlan", args }, describeSetPlan);
    if (ok) setConfirm(null);
  };

  const before = cellsOf(plan);
  const num = (k: keyof Form, label: string, hint?: string) => (
    <Field label={label} {...rowFor(k)} note={rowFor(k).note ?? hint}>
      <input
        className="input"
        inputMode="numeric"
        autoComplete="off"
        value={form[k]}
        onChange={(e) => set(k, e.target.value as never)}
        aria-invalid={Boolean(rowFor(k).error)}
      />
    </Field>
  );

  return (
    <div className="card tilt-r no-pin">
      <div className="label">{TXT.editLabel}</div>
      <p className="hint" style={{ marginTop: 6 }}>{TXT.editLede}</p>
      <div className="ykt-form">
        <div className="grid2">
          {num("cycleTL", PLAN_FIELD_LABELS_TR.cycleTL)}
          {num("maxOrderTL", PLAN_FIELD_LABELS_TR.maxOrderTL)}
          {num("startDay", PLAN_FIELD_LABELS_TR.startDay)}
          {num("deadlineDay", PLAN_FIELD_LABELS_TR.deadlineDay, TXT.deadlineNote)}
          {num("maxWaitH", PLAN_FIELD_LABELS_TR.maxWaitH)}
          <Field label={PLAN_FIELD_LABELS_TR.askMode} {...rowFor("askOnAmbiguity")}>
            <select className="input" value={form.askOnAmbiguity} onChange={(e) => set("askOnAmbiguity", e.target.value as "1" | "0")}>
              <option value="1">Evet, emin olmazsa sana sorar</option>
              <option value="0">Hayır, sormadan karar verir</option>
            </select>
          </Field>
        </div>
        <Field label={TXT.expiresField} {...rowFor("expiresDays")} note={rowFor("expiresDays").note ?? TXT.expiresHint}>
          <input className="input" inputMode="numeric" autoComplete="off" placeholder={`Şimdi: ${before.expiresAt}`} value={form.expiresDays} onChange={(e) => set("expiresDays", e.target.value)} />
        </Field>
      </div>

      {model.error && <p className="hint ykt-err" role="alert">{TXT.buildFail} {model.error}</p>}
      {/* alan hataları alanın altında görünür; burada yalnız alana bağlı olmayanlar ve kilitli alanlar */}
      {conf && conf.blockers.some((b) => b.field === null || isAddressField(b.field) || b.field === "agentId") && (
        <ul className="ykt-blockers" role="alert">
          {conf.blockers
            .filter((b) => b.field === null || isAddressField(b.field) || b.field === "agentId")
            .map((b, i) => <li key={`${b.code}${i}`} className="hint ykt-err">{b.messageTr}</li>)}
        </ul>
      )}
      {model.drift.length > 0 && <p className="hint ykt-err" role="alert">{TXT.drift} {model.drift.join(", ")}.</p>}

      {changed && conf?.activation && (
        <div className={`ykt-predict ${immediate ? "now" : "wait"}`}>
          <span className="label">{TXT.predict}</span>
          <p>{conf.activation.textTr}</p>
          <span className="hint">{TXT.predictNote}</span>
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <OnFuji>
          <button className="btn" disabled={!ready || busy} onClick={open}>{changed ? sendLabel : TXT.noChange}</button>
        </OnFuji>
        {changed && <button className="btn ghost small" type="button" onClick={() => setForm(formOf(plan))}>{TXT.reset}</button>}
      </div>

      {confirm && (
        <Modal title={TXT.confirmTitle} onClose={() => setConfirm(null)}>
          <div className="label">{TXT.confirmTitle}</div>
          <p className="hint" style={{ marginTop: 6 }}>{TXT.confirmLede}</p>
          <table className="simple ykt-table" style={{ marginTop: 10 }}>
            <tbody>
              {confirm.conf.rows.map((r) => {
                const diff = r.displayTr !== before[r.field] && !(r.field === "expiresAt" && !expiresEdited) && !isAddressField(r.field) && r.field !== "agentId";
                const badge = r.source === "edited" ? CONFIRM_BADGES_TR.edited : r.editable ? "mevcut plan" : "korunur";
                return (
                  <tr key={r.field} className={diff ? "ykt-diff" : ""}>
                    <th scope="row">{r.labelTr}</th>
                    <td>
                      {isAddressField(r.field) && r.chainValue ? <a href={explorerAddress(r.chainValue)} target="_blank" rel="noopener noreferrer">{short(r.chainValue)} ↗</a> : r.displayTr}
                      <span className="hint ykt-badge">{badge}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {confirm.conf.activation && (
            <div className={`ykt-predict ${confirm.conf.activation.immediate ? "now" : "wait"}`}>
              <span className="label">{TXT.predict}</span>
              <p>{confirm.conf.activation.textTr}</p>
            </div>
          )}
          {confirm.drift.length > 0 && <p className="hint ykt-err" role="alert">{TXT.drift} {confirm.drift.join(", ")}.</p>}
          {!confirm.conf.signable && confirm.conf.blockers.map((b, i) => <p key={i} className="hint ykt-err" role="alert">{b.messageTr}</p>)}
          <div className="row" style={{ marginTop: 16 }}>
            <OnFuji>
              <button className="btn" disabled={busy || !canSign || !confirm.conf.signable || confirm.drift.length > 0} onClick={sign}>{TXT.sign}</button>
            </OnFuji>
            <button className="btn ghost" type="button" onClick={() => setConfirm(null)}>{TXT.cancel}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── bekleyen plan ───────────────────────────────────────────────────────
function PendingWarning({ onStop }: { onStop: () => void }) {
  return (
    <div className="card no-pin ykt-warn" role="alert">
      <div className="label">{TXT.pendingLabel}</div>
      <h2 className="h3" style={{ marginTop: 6 }}>{TXT.pendingWarnTitle}</h2>
      <p className="note" style={{ marginTop: 8 }}>{TXT.pendingWarnBody}</p>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn ink" onClick={onStop}>{TXT.stopBtn}</button>
      </div>
    </div>
  );
}

function PendingCard({ active, pending, now, user, canSign, run, busy }: {
  active: Plan | null;
  pending: { plan: Plan; activeAt: number };
  now: number;
  user: Address;
  canSign: boolean;
  run: Run;
  busy: boolean;
}) {
  const left = pending.activeAt - now;
  const ready = left <= 0;
  const a = active ? cellsOf(active) : null;
  const p = cellsOf(pending.plan);
  return (
    <div className="card tilt-l no-pin kraft">
      <div className="label">{TXT.pendingLabel}</div>
      <div className="ykt-countdown" aria-live="off">
        <span className="amount">{ready ? "00:00:00" : fmtClock(left)}</span>
        <span className="hint">{ready ? TXT.pendingReady : `${TXT.pendingLeft} · ${TXT.pendingActivates}: ${fmtDate(pending.activeAt)}`}</span>
      </div>
      <table className="simple ykt-table ykt-difftable">
        <thead>
          <tr><th>{TXT.colField}</th><th>{TXT.colActive}</th><th>{TXT.colPending}</th></tr>
        </thead>
        <tbody>
          {PLAN_FIELDS.map((f) => {
            const changed = a === null || a[f] !== p[f];
            return (
              <tr key={f} className={changed ? "ykt-diff" : "ykt-same"}>
                <th scope="row">{PLAN_FIELD_LABELS_TR[f]}</th>
                <td>{a ? <Cell field={f} value={a[f]} /> : "—"}</td>
                <td><Cell field={f} value={p[f]} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 14 }}>
        <OnFuji>
          <button className="btn" disabled={!ready || busy || !canSign} onClick={() => void run("Bekleyen planı devreye al", { functionName: "commitPending", args: [user] }, () => ["Bekleyen plan devreye alındı."])}>
            {TXT.commit}
          </button>
        </OnFuji>
      </div>
    </div>
  );
}

// ── döngü + süresi dolan izinler ────────────────────────────────────────
type ExpiredAction = { id: string; amountTL: number; reportBy: number };

function CycleCard({ view, plan, now, user, reads, canSign, run, busy }: {
  view: View;
  plan: Plan;
  now: number;
  user: Address;
  reads: ChainReads | null;
  canSign: boolean;
  run: Run;
  busy: boolean;
}) {
  const c = view.cycle;
  const [scan, setScan] = useState<{ state: "idle" | "busy" | "fail" | "done"; items: ExpiredAction[] }>({ state: "idle", items: [] });
  const month = c.id !== 0 ? cycleIdParts(c.id) : null;
  let closeReason: string | null = null;
  if (c.id === 0) closeReason = TXT.cycleNone;
  else if (c.closed) closeReason = "Döngü zaten kapalı.";
  else if (c.reservedTL > 0) closeReason = "Açık izin var: önce süresi dolanları düşür.";
  else if (now < deadlineEndSec(now, plan.deadlineDay)) closeReason = `Son gün (ayın ${plan.deadlineDay}. günü) bitmedi.`;

  const doScan = async () => {
    if (!reads) return;
    setScan({ state: "busy", items: [] });
    try {
      const ev = await reads.readHistory(user);
      const ids = ev.flatMap((e) => (e.kind === "BuyAuthorized" ? [e.actionId] : [])).slice(-40);
      const items: ExpiredAction[] = [];
      for (const id of ids) {
        const act = await reads.readAction(id);
        if (act && act.state === "AUTHORIZED" && act.reportBy < Math.floor(Date.now() / 1000)) items.push({ id, amountTL: act.amountTL, reportBy: act.reportBy });
      }
      setScan({ state: "done", items });
    } catch {
      setScan({ state: "fail", items: [] });
    }
  };

  return (
    <div className="card tilt-r no-pin">
      <div className="between" style={{ flexWrap: "wrap" }}>
        <span className="label">{TXT.cycleLabel}{month ? ` · ${MONTHS[month.month - 1]} ${month.year}` : ""}</span>
        {c.id !== 0 && <span className="chip">{c.closed ? TXT.closedWord : TXT.openWord}</span>}
      </div>
      {c.id === 0 ? (
        <p className="hint" style={{ marginTop: 10 }}>{TXT.cycleNone}</p>
      ) : (
        <div className="grid2" style={{ marginTop: 12 }}>
          <div><div className="label">{TXT.spent}</div><div className="amount">{fmtTL(c.spentTL)}</div></div>
          <div><div className="label">{TXT.reserved}</div><div className="amount">{fmtTL(c.reservedTL)}</div></div>
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <OnFuji>
          <button className="btn small" disabled={closeReason !== null || busy || !canSign} onClick={() => void run(TXT.closeCycle, { functionName: "closeCycle", args: [user] }, () => ["Döngü kapatıldı."])}>
            {TXT.closeCycle}
          </button>
        </OnFuji>
        {closeReason && <span className="hint">{closeReason}</span>}
      </div>

      <div className="ykt-scan">
        <div className="row">
          <button className="btn ghost small" disabled={!reads || scan.state === "busy"} onClick={() => void doScan()}>
            {scan.state === "busy" ? TXT.scanning : TXT.scan}
          </button>
          <span className="hint">{TXT.expireHint}</span>
        </div>
        {scan.state === "fail" && <p className="hint ykt-err" role="alert">{TXT.scanFail}</p>}
        {scan.state === "done" && scan.items.length === 0 && <p className="hint">{TXT.scanNone}</p>}
        {scan.items.map((it) => (
          <div key={it.id} className="between ykt-expired">
            <span className="mono">İzin #{it.id} · {fmtTL(it.amountTL)} · rapor süresi {fmtDate(it.reportBy)}</span>
            <OnFuji>
              <button className="btn small" disabled={busy || !canSign} onClick={() => void run(TXT.expireOne, { functionName: "expireAction", args: [BigInt(it.id)] }, () => ["İzin düşürüldü; ayrılan tutar serbest."]).then((ok) => ok && setScan((s) => ({ ...s, items: s.items.filter((x) => x.id !== it.id) })))}>
                {TXT.expireOne}
              </button>
            </OnFuji>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Her şeyi durdur ─────────────────────────────────────────────────────
function RevokeCard({ canStop, onOpen }: { canStop: boolean; onOpen: () => void }) {
  return (
    <div className="card tilt-l no-pin ykt-stop">
      <div className="label">{TXT.stopLabel}</div>
      <p className="note" style={{ marginTop: 8 }}>{TXT.stopBody}</p>
      <div className="row" style={{ marginTop: 14 }}>
        <OnFuji>
          <button className="btn ink" disabled={!canStop} onClick={onOpen}>{TXT.stopBtn}</button>
        </OnFuji>
      </div>
    </div>
  );
}

function RevokeModal({ onClose, onYes, busy }: { onClose: () => void; onYes: () => void; busy: boolean }) {
  return (
    <Modal title={TXT.stopConfirmTitle} onClose={onClose}>
      <div className="label">{TXT.stopLabel}</div>
      <h2 className="h3" style={{ marginTop: 6 }}>{TXT.stopConfirmTitle}</h2>
      <ul className="ykt-list">
        {TXT.stopConfirmList.map((s) => <li key={s}>{s}</li>)}
      </ul>
      <div className="row" style={{ marginTop: 16 }}>
        <OnFuji>
          <button className="btn ink" disabled={busy} onClick={onYes}>{TXT.stopYes}</button>
        </OnFuji>
        <button className="btn ghost" type="button" onClick={onClose}>{TXT.cancel}</button>
      </div>
    </Modal>
  );
}

// ── ekran ───────────────────────────────────────────────────────────────
export default function Yetkiler() {
  const [sp] = useSearchParams();
  const preview = previewOf(sp.get("onizleme"));
  const dep = useDeployments();
  const deployments = deploymentsOf(dep);
  const reads = useChainReads();
  const { address: wallet, isConnected, onFuji } = useFujiGuard();
  const user = preview ? PREVIEW_USER : wallet;
  const flightPlan = (deployments?.flightPlan as Address | undefined) ?? null;
  const now = useNowSec();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["yetkiler", preview ?? flightPlan, user],
    enabled: preview ? true : reads !== null && user !== undefined,
    refetchInterval: preview ? false : 15_000,
    queryFn: async (): Promise<View> => {
      if (preview) return sampleView(preview);
      if (!reads || !user) throw new Error("okuma kapalı");
      const [{ plan, active }, pending, cycle] = await Promise.all([reads.readPlan(user), reads.readPending(user), reads.readCycle(user)]);
      return { plan, active, pending, cycle };
    },
  });

  // imza yalnız: gerçek veri (örnek değil) + kontrat okundu + cüzdan Fuji'de
  const canSign = !preview && flightPlan !== null && isConnected && onFuji;
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["yetkiler"] }), [qc]);
  const { run, busy, outcome, clearOutcome } = useActions(flightPlan, canSign, refresh);
  const [stopOpen, setStopOpen] = useState(false);

  const stop = async () => {
    const ok = await run(
      TXT.stopBtn,
      { functionName: "revoke", args: [] },
      (ev) => [hasEvent(ev, "PlanRevoked") ? TXT.stopped : "PlanRevoked olayı okunamadı; planın durumunu zincirden kontrol et.", ...(hasEvent(ev, "PendingCleared") ? [TXT.pendingCleared] : [])],
    );
    if (ok) setStopOpen(false);
  };

  const view = q.data;
  const badges: BadgeKind[] = preview ? ["demoPlan"] : [];

  let main: ReactNode;
  if (!preview && dep.status === "loading") {
    main = <div className="card no-pin"><div className="skeleton" style={{ height: 120 }} /></div>;
  } else if (!preview && dep.status === "none") {
    main = <StateCard label="NO_DEPLOYMENT" title={TXT.noDeploy} body={TXT.noDeployBody} />;
  } else if (!preview && dep.status === "invalid") {
    main = <StateCard label={TXT.badDeploy} title={TXT.badDeploy} body={dep.message} />;
  } else if (!preview && !user) {
    main = <StateCard label={TXT.label} title={TXT.connect} body={TXT.connectBody} />;
  } else if (q.isPending) {
    main = <div className="card no-pin"><div className="skeleton" style={{ height: 220 }} /></div>;
  } else if (q.isError || !view || !user) {
    main = (
      <StateCard label={TXT.readFail} title={TXT.readFail} body={TXT.readFailBody}>
        <button className="btn small" onClick={() => void q.refetch()}>{TXT.retry}</button>
      </StateCard>
    );
  } else if (!view.plan) {
    main = (
      <StateCard label={TXT.label} title={TXT.noPlan} body={TXT.noPlanBody}>
        <Link className="btn" to="/secim">{TXT.choose}</Link>
      </StateCard>
    );
  } else {
    const plan = view.plan;
    main = (
      <>
        {view.pending && <PendingWarning onStop={() => setStopOpen(true)} />}
        <div className="card tilt-l no-pin ykt-plan">
          <PlanTable plan={plan} active={view.active} now={now} />
          {preview && <p className="hint" style={{ marginTop: 12 }}>{TXT.demoNote}</p>}
        </div>
        {view.pending && (
          <PendingCard active={plan} pending={view.pending} now={now} user={user} canSign={canSign} run={run} busy={busy} />
        )}
        <PlanEditor key={JSON.stringify(plan) + String(view.active)} view={view} plan={plan} canSign={canSign} run={run} busy={busy} />
        <CycleCard view={view} plan={plan} now={now} user={user} reads={preview ? null : reads} canSign={canSign} run={run} busy={busy} />
      </>
    );
  }

  const hasPlan = Boolean(view?.plan);
  const side = (
    <>
      <RevokeCard canStop={canSign && hasPlan && !busy} onOpen={() => setStopOpen(true)} />
      <div className="card tilt-r no-pin">
        <div className="label">{TXT.helpLabel}</div>
        <ul className="ykt-list">
          {TXT.help.map((s) => <li key={s}>{s}</li>)}
        </ul>
      </div>
    </>
  );

  return (
    <Shell badges={badges} side={side}>
      <div className="card tape no-pin">
        <div className="label">{TXT.label}</div>
        <h1 className="title" style={{ marginTop: 6 }}>{TXT.title}</h1>
        <p className="note" style={{ marginTop: 14 }}>{TXT.lede}</p>
        <p className="hint" style={{ marginTop: 10 }}>{TXT.chain}</p>
      </div>

      {outcome && (
        <div className="card kraft no-pin ykt-outcome" role="status">
          <div className="between">
            <span className="label">{TXT.resultLabel} · {outcome.title}</span>
            <button className="btn ghost small" onClick={clearOutcome}>Kapat</button>
          </div>
          {outcome.lines.map((l) => <p key={l} className="note" style={{ marginTop: 8 }}>{l}</p>)}
          <p className="hint" style={{ marginTop: 8 }}>
            {fmtFinality(outcome.finalityMs)} ·{" "}
            <a href={explorerTx(outcome.hash)} target="_blank" rel="noopener noreferrer">Snowtrace'te gör ↗</a>
          </p>
        </div>
      )}

      {main}
      {stopOpen && <RevokeModal onClose={() => setStopOpen(false)} onYes={() => void stop()} busy={busy} />}
    </Shell>
  );
}
