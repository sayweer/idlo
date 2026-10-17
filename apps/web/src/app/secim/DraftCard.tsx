import { useState } from "react";
import { Link } from "react-router";
import {
  CONFIRM_BADGES_TR,
  PLAN_DRAFT_FIELDS,
  formatTL,
  type Candidate,
  type PlanDraft,
} from "@pilot/shared";
import { explorerTx } from "../../lib/fuji";
import { useLang } from "../../lib/i18n";
import { Badge } from "../Badges";
import { nameOf } from "./Candidates";
import { finalitySeconds, trDateTime, type PlanSetOutcome } from "./logic";
import type { AgentsOrigin, DraftErrorKind } from "./types";
import "./strings";

export type DraftView =
  | { status: "loading" }
  | { status: "ready"; draft: PlanDraft }
  | { status: "error"; kind: DraftErrorKind; message: string };

type DraftField = (typeof PLAN_DRAFT_FIELDS)[number];

function valueText(f: DraftField, v: number | boolean, t: (k: string, vars?: Record<string, string | number>) => string): string {
  switch (f) {
    case "cycleTL":
    case "maxOrderTL":
      return `${formatTL(v as number)} TL`;
    case "startDay":
    case "deadlineDay":
      return t("val.dayN", { n: v as number });
    case "maxWaitH":
      return t("val.hourN", { n: v as number });
    case "expiresInDays":
      return t("val.dayCount", { n: v as number });
    case "askOnAmbiguity":
      return t(v ? "val.yes" : "val.no");
  }
}

/** Kural Kartı (UI_HANDOFF §2.2 adım 3): değer + kaynak rozeti, sorular, yapabilir/yapamaz, "İmzaya geç". Düzeltme burada değil, pencerede. */
export function DraftCard({
  agent,
  origin,
  view,
  answersSent,
  onAnswers,
  onRetry,
  onSign,
  signReason,
}: {
  agent: Candidate;
  origin: AgentsOrigin;
  view: DraftView;
  /** Cevaplar gönderilirken true: yeni taslak bekleniyor. */
  answersSent: boolean;
  onAnswers: (a: { question: string; answer: string }[]) => void;
  onRetry: () => void;
  onSign: () => void;
  /** "İmzaya geç"i kapatan neden; null → açık. */
  signReason: string | null;
}) {
  const { t } = useLang();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const draft = view.status === "ready" ? view.draft : null;
  const answered = draft ? draft.questions.filter((q) => (typed[q] ?? "").trim() !== "") : [];

  return (
    <section className="card tilt-l pin-gold" aria-labelledby="draft-title" aria-busy={view.status === "loading"}>
      <div className="between">
        <span className="label">{t("secim.step.draft")}</span>
        <span className="rozetler">
          {origin === "fixture" && <Badge kind="mock" />}
          {agent.demo && <Badge kind="demo" />}
        </span>
      </div>
      <h2 className="h3" id="draft-title" style={{ marginTop: 6 }}>{t("secim.draft.title")}</h2>
      <p className="hint" style={{ marginTop: 4 }}>{t("secim.draft.agent")}: <b>{nameOf(agent)}</b> · #{agent.agentId}</p>

      {view.status === "loading" && <p className="empty skeleton-text" role="status">{t("secim.draft.reading")}</p>}

      {view.status === "error" && (
        <div className="reading" role="alert">
          <div className="label">{t(view.kind === "llm_unavailable" ? "secim.llm.none" : "secim.draft.failed")}</div>
          <p className="hint" style={{ marginTop: 4 }}>{view.kind === "llm_unavailable" ? t("secim.llm.noneBody") : view.message}</p>
          <button className="btn small" type="button" style={{ marginTop: 10 }} onClick={onRetry}>{t("secim.draft.retry")}</button>
        </div>
      )}

      {draft && (
        <>
          {draft.questions.length > 0 && (
            <div className="reading questions" role="group" aria-label={t("secim.draft.questions")}>
              <div className="label">{t("secim.draft.questions")}</div>
              <p className="hint" style={{ marginTop: 4 }}>{t("secim.draft.questionsBody")}</p>
              {draft.questions.map((q, i) => (
                <div className="field" key={q} style={{ marginTop: 10 }}>
                  <label className="note" htmlFor={`q-${i}`}>{q}</label>
                  <input
                    id={`q-${i}`}
                    className="input"
                    type="text"
                    maxLength={200}
                    placeholder={t("secim.draft.answer")}
                    value={typed[q] ?? ""}
                    disabled={answersSent}
                    onChange={(e) => setTyped((s) => ({ ...s, [q]: e.target.value }))}
                  />
                </div>
              ))}
              <button
                className="btn small"
                type="button"
                style={{ marginTop: 12 }}
                disabled={answered.length === 0 || answersSent}
                onClick={() => onAnswers(answered.map((q) => ({ question: q, answer: (typed[q] ?? "").trim() })))}
              >
                {answersSent ? t("secim.draft.sending") : t("secim.draft.send")}
              </button>
            </div>
          )}

          <table className="facts rulecard">
            <tbody>
              {PLAN_DRAFT_FIELDS.map((f) => {
                const d = draft[f];
                return (
                  <tr key={f}>
                    <th>{t(`f.${f}`)}</th>
                    <td>
                      <span className="rv">{d.value === null ? "—" : valueText(f, d.value, t)}</span>{" "}
                      <span className={`src src-${d.value === null ? "empty" : d.source}`}>
                        {d.value === null ? t("secim.draft.empty") : CONFIRM_BADGES_TR[d.source]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="grid2 cancan">
            <div className="notecard">
              <span className="label">{t("secim.draft.can")}</span>
              <p>{t("secim.draft.canBody")}</p>
            </div>
            <div className="notecard">
              <span className="label">{t("secim.draft.cannot")}</span>
              <p>{t("secim.draft.cannotBody")}</p>
            </div>
          </div>
          <p className="hint" style={{ marginTop: 12 }}>{t("secim.draft.read")}</p>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" type="button" disabled={signReason !== null} onClick={onSign}>{t("secim.draft.sign")}</button>
            {signReason && <span className="hint">{signReason}</span>}
          </div>
        </>
      )}
    </section>
  );
}

export type SignedResult = PlanSetOutcome & {
  hash: string;
  finalityMs: number;
  /** Pencerenin tahmini; olay farklıysa "olay geçerlidir" notu çıkar. */
  predictedImmediate: boolean | null;
  agentName: string;
};

/** Sonuç (UI_HANDOFF §2.2 adım 5): zincirdeki PlanSet olayı gösterilir, tahmin değil. */
export function ResultCard({ result, noEvent, onAgain }: { result: SignedResult | null; noEvent: { hash: string; finalityMs: number } | null; onAgain: () => void }) {
  const { t } = useLang();
  const hash = result?.hash ?? noEvent?.hash;
  const ms = result?.finalityMs ?? noEvent?.finalityMs ?? 0;
  return (
    <section className="card tape kraft no-pin" role="status" aria-labelledby="res-title">
      <span className="label">{t("res.step")}</span>
      {result ? (
        <h2 className="h3" id="res-title" style={{ marginTop: 6 }}>
          {result.immediate ? t("res.now") : t("res.later", { time: trDateTime(result.activeAt) })}
        </h2>
      ) : (
        <h2 className="h3" id="res-title" style={{ marginTop: 6 }}>{t("res.noEvent")}</h2>
      )}
      {result && <p className="hint" style={{ marginTop: 6 }}>{result.agentName}</p>}
      <p className="mono" style={{ marginTop: 10 }}>{t("res.finality", { sec: finalitySeconds(ms) })}</p>
      {hash && <a className="mono" href={explorerTx(hash)} target="_blank" rel="noopener noreferrer">{t("res.view")}</a>}
      {result && <p className="hint" style={{ marginTop: 8 }}>{t("res.hash")}: <span className="mono">{result.planHash}</span></p>}
      {result?.pendingCleared && <p className="hint" style={{ marginTop: 8 }}>{t("res.cleared")}</p>}
      {result && result.predictedImmediate !== null && result.predictedImmediate !== result.immediate && (
        <p className="hint" style={{ marginTop: 8 }}>{t("res.differs")}</p>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <Link className="btn small" to="/yetkiler">{t("nav.yetkiler")}</Link>
        <button className="btn ghost small" type="button" onClick={onAgain}>{t("res.again")}</button>
      </div>
    </section>
  );
}
