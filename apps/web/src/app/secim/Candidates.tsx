import {
  DEFAULT_THRESHOLDS,
  type Candidate,
  type Eliminated,
  type RankedAgent,
  type SelectionResult,
  type Thresholds,
} from "@pilot/shared";
import { short } from "../../lib/format";
import { useLang } from "../../lib/i18n";
import { Badge } from "../Badges";
import { scoreText } from "./logic";
import type { AgentsOrigin } from "./types";
import "./strings";

export const nameOf = (c: Candidate): string => c.card?.name ?? `Ajan #${c.agentId}`;

/** Sıralama çıktısındaki sırayla; sıralamada olmayan aday (olmamalı) sona eklenir. */
function inRankOrder(result: SelectionResult): { c: Candidate; rank: RankedAgent | null }[] {
  const byId = new Map(result.screen.kept.map((c) => [c.agentId, c]));
  const out: { c: Candidate; rank: RankedAgent | null }[] = [];
  for (const r of result.ranking.items) {
    const c = byId.get(r.agentId);
    if (c) {
      out.push({ c, rank: r });
      byId.delete(r.agentId);
    }
  }
  for (const c of byId.values()) out.push({ c, rank: null });
  return out;
}

function KeptCard({
  c,
  rank,
  n,
  picked,
  pickReason,
  onPick,
}: {
  c: Candidate;
  rank: RankedAgent | null;
  n: number;
  picked: boolean;
  /** Seçimi kapatan neden (LLM yok ya da başka bir seçim sürüyor); null → seçilebilir. */
  pickReason: string | null;
  onPick: (c: Candidate) => void;
}) {
  const { t } = useLang();
  return (
    <article className={`decision cand ${picked ? "is-picked" : ""}`} aria-labelledby={`cand-${c.agentId}`}>
      <div className="between cand-head">
        <div>
          <div className="label">{t("secim.cand.rank")} {n}</div>
          <h3 className="dtitle" id={`cand-${c.agentId}`}>{nameOf(c)}</h3>
        </div>
        <span className="rozetler">{c.demo && <Badge kind="demo" />}</span>
      </div>
      {c.card && <p className="cand-desc">{c.card.description}</p>}
      <table className="facts">
        <tbody>
          <tr><th>{t("secim.cand.id")}</th><td>#{c.agentId}</td></tr>
          <tr>
            <th>{t("secim.cand.users")}</th>
            <td>
              {c.verifiedClients.length}
              {c.verifiedClients.length > 0 && <span className="muted"> · {c.verifiedClients.map((a) => short(a)).join(", ")}</span>}
            </td>
          </tr>
          <tr><th>{t("secim.cand.feedback")}</th><td>{c.feedbackCount}<span className="muted"> · {t("secim.cand.clients", { n: c.feedbackClients })}</span></td></tr>
          <tr><th>{t("secim.cand.score")}</th><td>{scoreText(c.score)}</td></tr>
        </tbody>
      </table>
      {rank && (
        <div className="reading">
          <div className="label">{t(rank.source === "llm" ? "secim.cand.why.llm" : "secim.cand.why.rule")}</div>
          <p className="note">{rank.rationaleTr}</p>
        </div>
      )}
      <div className="row cand-foot">
        <button className="btn small" type="button" disabled={pickReason !== null} aria-pressed={picked} onClick={() => onPick(c)}>
          {picked ? t("secim.cand.picked") : t("secim.cand.pick")}
        </button>
        {pickReason && <span className="hint">{pickReason}</span>}
      </div>
    </article>
  );
}

function EliminatedRow({ e }: { e: Eliminated }) {
  const { t } = useLang();
  return (
    <li className="decision elim">
      <div className="between">
        <h3 className="dtitle">{e.nameTr ?? `Ajan #${e.agentId}`}</h3>
        <span className="rozetler">{e.demo && <Badge kind="demo" />}</span>
      </div>
      <div className="row elim-meta">
        <span className="chip">#{e.agentId}</span>
      </div>
      <p className="elim-reason"><span className="label">{t("secim.elim.reason")}</span> {e.reasonTr}</p>
    </li>
  );
}

/** Kalan ve elenen adaylar. Elenenler kırmızı değil, nötr: eleme bir alarm değil, kodun eşiğidir. */
export function Candidates({
  result,
  origin,
  pickedId,
  pickReason,
  onPick,
}: {
  result: SelectionResult;
  origin: AgentsOrigin;
  pickedId: string | null;
  pickReason: string | null;
  onPick: (c: Candidate) => void;
}) {
  const { t } = useLang();
  const kept = inRankOrder(result);
  return (
    <section className="card tilt-r pin-gold" aria-labelledby="cands-title">
      <div className="between">
        <span className="label">{t("secim.step.cands")}</span>
        <span className="rozetler">{origin === "fixture" && <Badge kind="mock" />}</span>
      </div>
      <h2 className="h3" id="cands-title" style={{ marginTop: 6 }}>{t("secim.cands.title")}</h2>
      <p className="note cands-rule">{t("secim.cands.rule")}</p>
      <div className="notecard need" role="note">
        <span className="label">{t("secim.cands.need")}</span>
        <p>{result.need.summaryTr}</p>
      </div>
      {origin === "fixture" && <p className="hint" style={{ marginTop: 10 }}>{t("secim.cands.fixture")}</p>}
      {result.notesTr.length > 0 && (
        <ul className="notes">{result.notesTr.map((n) => <li key={n} className="hint">{n}</li>)}</ul>
      )}

      {kept.length === 0 ? (
        <p className="empty">{t("secim.cands.empty")}</p>
      ) : (
        <div className="declist">
          {kept.map(({ c, rank }, i) => (
            <KeptCard
              key={c.agentId}
              c={c}
              rank={rank}
              n={i + 1}
              picked={pickedId === c.agentId}
              pickReason={pickReason}
              onPick={onPick}
            />
          ))}
        </div>
      )}

      {result.screen.eliminated.length > 0 && (
        <div className="dsection elim-section">
          <h3 className="h3">{t("secim.elim.title")}</h3>
          <p className="hint" style={{ marginTop: 4 }}>{t("secim.elim.note")}</p>
          <ul className="declist">
            {result.screen.eliminated.map((e) => <EliminatedRow key={e.agentId} e={e} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Yan kolon: kodun eşikleri ve LLM'in sınırı. Sayılar @pilot/shared'in eşiklerindendir. */
export function ThresholdCard({ thresholds }: { thresholds: Thresholds }) {
  const { t } = useLang();
  const relaxed = thresholds.minVerifiedClients < DEFAULT_THRESHOLDS.minVerifiedClients || thresholds.minFeedback < DEFAULT_THRESHOLDS.minFeedback || thresholds.minScore < DEFAULT_THRESHOLDS.minScore;
  return (
    <div className="card tilt-l kraft" role="note">
      <div className="label">{t("secim.side.title")}</div>
      <ul className="checks" style={{ marginTop: 10 }}>
        <li><span>•</span><span>{t("secim.side.minFeedback", { n: thresholds.minFeedback })}</span></li>
        <li><span>•</span><span>{t("secim.side.minScore", { n: thresholds.minScore })}</span></li>
        <li><span>•</span><span>{t("secim.side.minClients", { n: thresholds.minVerifiedClients })}</span></li>
      </ul>
      {relaxed && (
        <p className="hint relaxed" style={{ marginTop: 12 }}>
          {t("secim.side.relaxed", { n: DEFAULT_THRESHOLDS.minVerifiedClients, m: DEFAULT_THRESHOLDS.minFeedback, p: DEFAULT_THRESHOLDS.minScore })}
        </p>
      )}
      <p className="hint" style={{ marginTop: 12 }}>{t("secim.side.sybil")}</p>
      <p className="hint" style={{ marginTop: 8 }}>{t("secim.side.llm")}</p>
      <p className="hint" style={{ marginTop: 8 }}>{t("secim.side.flow")}</p>
    </div>
  );
}
