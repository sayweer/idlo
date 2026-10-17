import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "wagmi";
import {
  CONFIRM_BADGES_TR,
  applyEdit,
  buildPlanConfirmation,
  msToSec,
  type Candidate,
  type ConfirmRow,
  type EditablePlanField,
  type Plan,
  type PlanConfirmation,
  type PlanDraft,
} from "@pilot/shared";
import { createChainReads, deploymentsOf, useDeployments } from "../../lib/data";
import { useLang } from "../../lib/i18n";
import { useTx } from "../../lib/tx";
import { Badge } from "../Badges";
import { OnFuji } from "../Wallet";
import { nameOf } from "./Candidates";
import type { SignedResult } from "./DraftCard";
import { agentPlanContext, buildSignRequest, readPlanSet } from "./logic";
import type { AgentsOrigin } from "./types";
import "./strings";

/** UI_HANDOFF §2.2 adım 4: pencere uzun süre açık kalırsa değerler eskir (öneri: 10 dk). TODO(spec): eşik SPEC'te yok. */
const STALE_AFTER_MS = 10 * 60 * 1000;
const POLL_MS = 15_000;

type Edit = { field: EditablePlanField; value: string | boolean };
type Prep =
  | { status: "loading" }
  | { status: "need-wallet" }
  | { status: "error"; text: string; body?: string }
  | { status: "ready"; conf: PlanConfirmation; snapshot: string; builtAt: number };

const srcClass = (badge: string): string =>
  badge === CONFIRM_BADGES_TR.edited ? "edited" : badge === CONFIRM_BADGES_TR.derived ? "derived" : badge === CONFIRM_BADGES_TR.user ? "user" : "default";

function Row({
  r,
  locked,
  onApply,
}: {
  r: ConfirmRow;
  locked: boolean;
  onApply: (field: EditablePlanField, value: string | boolean) => void;
}) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const field = r.field as EditablePlanField;
  const isDays = r.field === "expiresAt";
  const apply = (v: string | boolean) => {
    onApply(field, v);
    setEditing(false);
  };
  return (
    <li id={`crow-${r.field}`} className={`crow ${r.error ? "has-error" : ""}`}>
      <div className="crow-top">
        <span className="crow-label">{r.labelTr}</span>
        <span className={`src src-${srcClass(r.badgeTr)}`}>{r.badgeTr}</span>
      </div>
      <div className="crow-val">{r.displayTr}</div>
      <div className="crow-chain mono">{t("win.col.value")}: <b>{r.chainValue ?? "—"}</b></div>
      {r.note && <p className="crow-note">{r.note}</p>}
      {r.error && <p className="crow-warn" role="alert">{r.error}</p>}
      {r.editable && !locked && !editing && (
        <button
          className="btn ghost small crow-fix"
          type="button"
          onClick={() => {
            setText(isDays ? "" : (r.chainValue ?? ""));
            setEditing(true);
          }}
        >
          {t("win.fix")}
        </button>
      )}
      {r.editable && !locked && editing && (
        <form
          className="crow-edit"
          onSubmit={(e) => {
            e.preventDefault();
            apply(text);
          }}
        >
          {r.field === "askMode" ? (
            <div className="row">
              <button className="btn small" type="button" onClick={() => apply(true)}>{t("val.yes")}</button>
              <button className="btn small" type="button" onClick={() => apply(false)}>{t("val.no")}</button>
              <button className="btn ghost small" type="button" onClick={() => setEditing(false)}>{t("win.cancelEdit")}</button>
            </div>
          ) : (
            <>
              <label className="hint" htmlFor={`edit-${r.field}`}>{isDays ? t("win.edit.days") : t("win.edit.digits")}</label>
              <div className="row">
                <input
                  id={`edit-${r.field}`}
                  className="input crow-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.currentTarget.value)}
                />
                <button className="btn small" type="submit">{t("win.apply")}</button>
                <button className="btn ghost small" type="button" onClick={() => setEditing(false)}>{t("win.cancelEdit")}</button>
              </div>
            </>
          )}
        </form>
      )}
    </li>
  );
}

/**
 * "Zincire yazılacak değerler" penceresi (UI_HANDOFF §2.2 adım 4). İmzadan önceki TEK ekran: `setPlan`'a gidecek
 * değerlerin tamamını `buildPlanConfirmation` kurar, düzeltmeyi `applyEdit` yapar; burada doğrulama yazılmaz.
 * İmza yalnız buradan, yalnız `conf.setPlanArgs` ile yapılır.
 */
export function ConfirmWindow({
  draft,
  agent,
  origin,
  onClose,
  onSigned,
}: {
  draft: PlanDraft;
  agent: Candidate;
  origin: AgentsOrigin;
  onClose: () => void;
  onSigned: (r: SignedResult | null, fallback: { hash: string; finalityMs: number }) => void;
}) {
  const { t } = useLang();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const depState = useDeployments();
  const deps = deploymentsOf(depState);
  const reads = useMemo(() => (deps ? createChainReads(deps) : null), [deps]);
  const { address } = useConnection();
  const { send } = useTx();

  const [prep, setPrep] = useState<Prep>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [stale, setStale] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notDone, setNotDone] = useState(false);
  const editsRef = useRef<Edit[]>([]);
  const lockedRef = useRef(false);

  const planCtx = useMemo(() => agentPlanContext(agent, origin, deps), [agent, origin, deps]);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Pencereyi (yeniden) kur: zincirden mevcut plan okunur; okunamazsa pencere açılmaz (fail-closed).
  useEffect(() => {
    if (depState.status === "loading" || lockedRef.current) return;
    let live = true;
    (async () => {
      setPrep({ status: "loading" });
      setStale(false);
      let current: Plan | null = null;
      let active = false;
      let snapshot = "none";
      if (deps) {
        if (!address) return live && setPrep({ status: "need-wallet" });
        try {
          const r = await reads!.readPlan(address);
          current = r.plan;
          active = r.active;
          snapshot = JSON.stringify([r.plan, r.active]);
        } catch {
          return live && setPrep({ status: "error", text: t("win.noPlan"), body: t("win.noPlanBody") });
        }
      }
      try {
        let conf = buildPlanConfirmation(draft, {
          nowSec: msToSec(Date.now()),
          deployments: planCtx.deployments,
          current,
          currentActive: active,
        });
        for (const e of editsRef.current) conf = applyEdit(conf, e.field, e.value);
        if (live) setPrep({ status: "ready", conf, snapshot, builtAt: Date.now() });
      } catch {
        if (live) setPrep({ status: "error", text: t("win.bad") });
      }
    })();
    return () => {
      live = false;
    };
  }, [depState.status, deps, reads, address, draft, planCtx, nonce, t]);

  // Eskime: 10 dk geçti ya da zincirdeki plan değişti → imza kapanır, "Yenile" çıkar.
  useEffect(() => {
    if (prep.status !== "ready" || locked) return;
    const { snapshot, builtAt } = prep;
    const id = window.setInterval(async () => {
      if (Date.now() - builtAt > STALE_AFTER_MS) return setStale(true);
      if (!reads || !address) return;
      try {
        const r = await reads.readPlan(address);
        if (JSON.stringify([r.plan, r.active]) !== snapshot) setStale(true);
      } catch {
        /* okunamayan yoklama eskitmez; imza anında ağ zaten doğrular */
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [prep, locked, reads, address]);

  const onApply = useCallback((field: EditablePlanField, value: string | boolean) => {
    editsRef.current = [...editsRef.current, { field, value }];
    setPrep((p) => (p.status === "ready" ? { ...p, conf: applyEdit(p.conf, field, value) } : p));
  }, []);

  const sign = async () => {
    if (prep.status !== "ready" || stale || planCtx.demoLock || !address) return;
    const req = buildSignRequest(deps, prep.conf);
    if (req === null || deps === null) return;
    lockedRef.current = true;
    setLocked(true);
    setNotDone(false);
    const r = await send("Uçuş Planı", req as Parameters<typeof send>[1]);
    if (r === null) {
      lockedRef.current = false;
      setLocked(false);
      setNotDone(true);
      return;
    }
    const ev = readPlanSet(r.receipt, deps.flightPlan as `0x${string}`, address);
    onSigned(
      ev
        ? {
            ...ev,
            hash: r.hash,
            finalityMs: r.finalityMs,
            predictedImmediate: prep.conf.activation?.immediate ?? null,
            agentName: nameOf(agent),
          }
        : null,
      { hash: r.hash, finalityMs: r.finalityMs },
    );
  };

  const conf = prep.status === "ready" ? prep.conf : null;
  const canSign = conf !== null && conf.signable && !stale && !planCtx.demoLock && deps !== null;

  return (
    <dialog
      ref={dialogRef}
      className="confwin"
      aria-labelledby="conf-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!lockedRef.current) onClose();
      }}
    >
      <div className="card confcard no-pin tape">
        <div className="between">
          <span className="rozetler">
            {origin === "fixture" && <Badge kind="mock" />}
            {agent.demo && <Badge kind="demo" />}
          </span>
          <button className="btn ghost small" type="button" disabled={locked} onClick={onClose}>{t("win.close")}</button>
        </div>
        <h2 className="title conf-title" id="conf-title" tabIndex={-1} autoFocus>{conf?.titleTr ?? "Zincire yazılacak değerler"}</h2>
        <p className="hint" style={{ marginTop: 8 }}>{t("win.agent")}: <b>{nameOf(agent)}</b> · #{agent.agentId}</p>

        {prep.status === "loading" && <p className="empty" role="status">{t("win.loading")}</p>}
        {prep.status === "need-wallet" && (
          <div className="reading" role="status">
            <p className="note">{t("win.connect")}</p>
            <p className="hint" style={{ marginTop: 6 }}>{t("wallet.pitch")}</p>
          </div>
        )}
        {prep.status === "error" && (
          <div className="reading" role="status">
            <div className="label">{prep.text}</div>
            {prep.body && <p className="hint" style={{ marginTop: 4 }}>{prep.body}</p>}
            <button className="btn small" type="button" style={{ marginTop: 10 }} onClick={() => setNonce((n) => n + 1)}>{t("win.again")}</button>
          </div>
        )}

        {conf && (
          <>
            <ul className="crows" aria-label={conf.titleTr}>
              {conf.rows.map((r) => <Row key={r.field} r={r} locked={locked} onApply={onApply} />)}
            </ul>

            {conf.blockers.length > 0 && (
              <div className="reading blockers" role="status">
                <div className="label">{t("win.blockers")}</div>
                <ul>
                  {conf.blockers.map((b, i) => (
                    <li key={`${b.code}-${b.field ?? i}`}>
                      <span>{b.messageTr}</span>
                      {b.field && (
                        <button
                          className="linkbtn"
                          type="button"
                          onClick={() => document.getElementById(`crow-${b.field}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                        >
                          {t("win.goto")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {planCtx.demoLock && <p className="hint demo-lock" role="status">{t("win.demoLock")}</p>}
            {stale && (
              <div className="reading" role="status">
                <div className="label">{t("win.stale")}</div>
                <p className="hint" style={{ marginTop: 4 }}>{t("win.staleBody")}</p>
                <button className="btn small" type="button" style={{ marginTop: 10 }} onClick={() => setNonce((n) => n + 1)}>{t("win.refresh")}</button>
              </div>
            )}

            {conf.activation && (
              <div className="activation" role="status">
                <span className="label">{t("win.activation")}</span>
                <p className="note">{conf.activation.textTr}</p>
                <p className="hint">{t("win.estimate")}</p>
              </div>
            )}

            {locked && <p className="hint" role="status">{t("win.locked")}</p>}
            {notDone && <p className="hint" role="status">{t("win.notDone")}</p>}

            <div className="row conf-sign">
              <OnFuji>
                <button className="btn" type="button" disabled={!canSign || locked} onClick={sign}>
                  {locked ? t("win.signing") : t("win.sign")}
                </button>
              </OnFuji>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
