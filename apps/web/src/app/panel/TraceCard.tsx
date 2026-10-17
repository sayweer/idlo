import type { ReactNode } from "react";
import {
  EXEC_STATUS_TEXTS,
  KullaniciyaSorInputSchema,
  REJECT_TEXTS,
  VERDICT_TEXTS,
  WEATHER_CLASS_TEXTS,
  elapsedSec,
  formatDecimalTr,
  formatTL,
  optionText,
  parseOptionId,
  type Trace,
} from "@pilot/shared";
import type { PilotFeed } from "../../lib/data";
import { Badge, type BadgeKind } from "../Badges";
import { STALE_MS, type Loaded } from "./hooks";
import { T } from "./text";
import { trClock, trDateTime, trNumber } from "./time";
import { choiceOf, parseStepOut, reasonText, type ChoiceView } from "./trace";
import { Head, TxRef, UnknownBody } from "./ui";

type Step = Trace["steps"][number];

/** Seçenek kimliğinin Türkçe adı; çözülemezse ham kimlik (tahmin yok). */
export function optionLabel(id: string): string {
  try {
    return optionText(parseOptionId(id));
  } catch {
    return id;
  }
}

function Unverified({ out }: { out: unknown }) {
  if (out === undefined) return <p className="hint pn-gray">{T.noOut}</p>;
  let raw = "";
  try {
    raw = JSON.stringify(out);
  } catch {
    raw = String(out);
  }
  return (
    <div className="pn-gray">
      <p className="hint"><b>{T.unverified}</b></p>
      <details>
        <summary className="hint">{T.showRaw}</summary>
        <pre className="pn-raw">{raw.length > 600 ? `${raw.slice(0, 600)}…` : raw}</pre>
      </details>
    </div>
  );
}

function Chips({ ids, rec, pick }: { ids: readonly string[]; rec?: string; pick?: string }) {
  return (
    <span className="pn-chips">
      {ids.map((id) => (
        <span key={id} className={`chip${id === rec ? " rec" : ""}${id === pick ? " pick" : ""}`}>
          {optionLabel(id)}
          {id === rec && <i className="hint"> · {T.recommended}</i>}
        </span>
      ))}
    </span>
  );
}

/** Tek adımın gövdesi: çıktı aracın tam şemasıyla daraltılır; parse olmazsa gri "doğrulanmamış çıktı". */
function StepBody({ s, choice }: { s: Step; choice: ChoiceView | null }): ReactNode {
  if (s.error) return <p className="hint pn-gray">{T.errorPrefix}: {s.error}</p>;
  switch (s.tool) {
    case "plan_oku": {
      const o = parseStepOut("plan_oku", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <p>
          {o.active ? "Plan etkin" : T.planInactive}
          {o.plan && o.cycle && <> · {formatTL(o.cycle.spentTL)} / {formatTL(o.plan.cycleTL)} TL</>}
        </p>
      );
    }
    case "hava_durumu": {
      const o = parseStepOut("hava_durumu", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <p>
          {WEATHER_CLASS_TEXTS[o.class]} · zd {trNumber(o.zd, 1)}
          {o.alarm && <> · <b className="pn-red">{T.alarm}</b></>}
        </p>
      );
    }
    case "bakiye_oku": {
      const o = parseStepOut("bakiye_oku", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <p>
          TRY {formatDecimalTr(o.TRY.trading)} · USDT {formatDecimalTr(o.USDT.trading)}
          {o.TRY.funding !== null && <span className="hint"> · TRY fon {formatDecimalTr(o.TRY.funding)}</span>}
        </p>
      );
    }
    case "kural_danis": {
      const o = parseStepOut("kural_danis", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <>
          <p className="hint">{T.allowed}:</p>
          <Chips ids={o.allowed} rec={choice?.recommended ?? o.recommended} pick={choice?.chosen} />
          <p className="hint" style={{ marginTop: 4 }}>{o.reason}</p>
        </>
      );
    }
    case "teklif_al": {
      const o = parseStepOut("teklif_al", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <>
          <p>
            <span className={`chip${o.verdict === "RET" ? " open" : ""}`}>{VERDICT_TEXTS[o.verdict]}</span>{" "}
            {o.readback}
          </p>
          {o.reasons.length > 0 && <p className="hint">{o.reasons.map(reasonText).join(" ")}</p>}
        </>
      );
    }
    case "izin_iste": {
      const o = parseStepOut("izin_iste", s.out);
      if (!o) return <Unverified out={s.out} />;
      if (o.status === "AUTHORIZED") {
        return (
          <p>
            {T.authorized} · #{o.actionId} · {trNumber(elapsedSec(0, o.finalityMs), 1)} sn'de kesinleşti · <TxRef hash={o.tx} />
          </p>
        );
      }
      if (o.status === "REJECTED") {
        return (
          <div className="pn-rej">
            <p><span className="obadge o-rejected">RET</span> <b>{T.rejected}</b></p>
            <p>{REJECT_TEXTS[o.code]}</p>
            <p className="hint">{T.txOk} <TxRef hash={o.tx} /></p>
          </div>
        );
      }
      return (
        <p className="pn-gray">
          <b>{T.refused}.</b> {o.message}
        </p>
      );
    }
    case "emri_uygula": {
      const o = parseStepOut("emri_uygula", s.out);
      if (!o) return <Unverified out={s.out} />;
      const status = o.status === "NOT_PLACED" ? T.notPlaced : EXEC_STATUS_TEXTS[o.status];
      return (
        <>
          <p className="row" style={{ gap: 6 }}>
            <span className={`chip${o.verdict === "RET" ? " open" : ""}`}>{VERDICT_TEXTS[o.verdict]}</span>
            <span>{status}</span>
            {o.paper && <Badge kind="paper" />}
            <span className="hint mono">{o.clOrdId}</span>
          </p>
          <p>{o.readback}</p>
          {o.reasons.length > 0 && <p className="hint">{o.reasons.map(reasonText).join(" ")}</p>}
          {o.reportTx && <p className="hint">rapor: <TxRef hash={o.reportTx} /></p>}
        </>
      );
    }
    case "kullaniciya_sor": {
      const i = KullaniciyaSorInputSchema.safeParse(s.in);
      const o = parseStepOut("kullaniciya_sor", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <>
          {i.success && (
            <>
              <p>{i.data.soru}</p>
              <Chips ids={i.data.secenekler} />
            </>
          )}
          <p className="hint">{o.posted ? "Panele soruldu." : "Soru panele düşmedi."}</p>
        </>
      );
    }
    case "haberleri_oku": {
      const o = parseStepOut("haberleri_oku", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <>
          <p className="row" style={{ gap: 6 }}>
            {o.demo && <Badge kind="demo" />}
            <span className="chip">{T.untrusted}</span>
            <span className="hint">{o.items.length} haber</span>
          </p>
          <ul className="pn-news">
            {o.items.map((n) => (
              <li key={n.id}>
                <b>{n.title}</b>
                <span className="hint"> · {n.source}</span>
                <p className="hint">{n.body}</p>
              </li>
            ))}
          </ul>
        </>
      );
    }
    case "ekonomik_takvim": {
      const o = parseStepOut("ekonomik_takvim", s.out);
      if (!o) return <Unverified out={s.out} />;
      return (
        <>
          <p className="row" style={{ gap: 6 }}>
            {o.demo && <Badge kind="demo" />}
            <span className="hint">{o.events.length} planlı açıklama</span>
          </p>
          <ul className="pn-news">
            {o.events.map((e, k) => (
              <li key={k} className="hint">{trClock(e.ts)} · {e.title}</li>
            ))}
          </ul>
        </>
      );
    }
    case "bekle": {
      const o = parseStepOut("bekle", s.out);
      if (!o) return <Unverified out={s.out} />;
      return <p>Bekliyor · bitiş {trClock(o.untilMs)}</p>;
    }
    case "bitir": {
      const o = parseStepOut("bitir", s.out);
      if (!o) return <Unverified out={s.out} />;
      const ozet = typeof s.in?.ozet === "string" ? s.in.ozet : null;
      return <p>Bu ay tamam{ozet ? `: ${ozet}` : "."}</p>;
    }
  }
}

function TraceItem({ t, injectionDemo, replay, open }: { t: Trace; injectionDemo: boolean; replay: boolean; open: boolean }) {
  const choice = choiceOf(t);
  const injected = injectionDemo && t.steps.some((s) => s.tool === "haberleri_oku" && parseStepOut("haberleri_oku", s.out)?.demo);
  return (
    <details className="decision pn-trace" open={open}>
      <summary className="pn-sum">
        <span className="label">
          {T.turn} {t.turn} · {trClock(t.ts)}
          {replay && ` (${T.clockNote})`}
        </span>
        <span className="rozetler">
          {t.mode === "rules" ? <Badge kind="rules" /> : <span className="chip">{T.llm}</span>}
          {injected && <Badge kind="injection" />}
          {choice?.differs && <span className="obadge o-held">{T.differs}</span>}
        </span>
      </summary>
      <ol className="pn-steps">
        {t.steps.map((s, i) => (
          <li key={i} className="pn-step">
            <span className="pn-tool mono">{s.tool}</span>
            <div className="pn-out">
              <StepBody s={s} choice={choice} />
            </div>
          </li>
        ))}
      </ol>
      <div className="reading">
        <span className="label">{T.rationale}</span>
        <p className="note">{t.rationaleTr}</p>
      </div>
      <p className="dfoot">
        <span className="mono">{trDateTime(t.ts)}{replay ? ` · ${T.clockNote}` : ""}</span>
        <span className="mono">{t.cycleId}</span>
      </p>
    </details>
  );
}

/**
 * PİLOT izi: tur başına bir kart (yeni → eski). Kart gelen sırayı gösterir, hiçbir araç sırasını varsaymaz.
 * Zarf adaptörde zod ile doğrulandığı için doğrulanamayan tur tüm beslemeyi "bilinmiyor" yapar.
 * TODO(spec): tur başına "doğrulanmamış" etiketi için zarfın ham tur dizisi gerekir (Barış ile).
 */
export function TraceCard({ feed, now }: { feed: Loaded<PilotFeed>; now: number }) {
  let body: ReactNode;
  if (feed.status === "idle") body = <UnknownBody note={T.noFeedUser} />;
  else if (feed.status === "loading") body = <div className="skeleton" style={{ marginTop: 14, height: 90 }} />;
  else if (feed.status === "error") body = <UnknownBody note={T.feedDown} />;
  else {
    const f = feed.data;
    const stale = now - f.generatedAt > STALE_MS;
    body = (
      <>
        {stale && <p className="hint pn-gray" role="status" style={{ marginTop: 8 }}>{T.traceStale}</p>}
        {!f.pilot.alive && <p className="hint pn-gray" role="status" style={{ marginTop: 8 }}>{T.pilotDead}</p>}
        {f.traces.length === 0 ? (
          <p className="note" style={{ marginTop: 12 }}>{T.traceEmpty}</p>
        ) : (
          <div className="declist">
            {f.traces.map((t, i) => (
              <TraceItem key={`${t.turn}-${t.ts}`} t={t} injectionDemo={f.pilot.injectionDemo} replay={f.pilot.src === "replay"} open={i < 2} />
            ))}
          </div>
        )}
      </>
    );
  }
  const kinds: BadgeKind[] = [];
  if (feed.status === "ok") {
    if (feed.data.pilot.src === "replay") kinds.push("replay");
    if (feed.data.pilot.injectionDemo) kinds.push("injection");
  }
  return (
    <section className="card" aria-label={T.traceLabel}>
      <Head label={T.traceLabel} kinds={kinds} />
      {body}
    </section>
  );
}

