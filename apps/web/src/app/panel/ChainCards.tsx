import {
  EXEC_STATUS_TEXTS,
  REJECT_TEXTS,
  STOLEN_KEY_MESSAGE,
  execStatusFromChain,
  formatPxTr,
  formatTL,
  pxE6FromChain,
  rejectCodeName,
  secToMs,
  tlFromChain,
} from "@pilot/shared";
import type { PlanEvent } from "../../lib/data";
import { explorerTx } from "../../lib/fuji";
import { short } from "../../lib/format";
import type { BadgeKind } from "../Badges";
import type { ChainView } from "./hooks";
import { T } from "./text";
import { cycleName, trDateTime } from "./time";
import { GateNote, Head } from "./ui";

const LIMIT = 10;

/** Zincir değerleri biçimlenirken fırlatan birim dönüşümü ekranı çökertmesin: bilinmeyen değer "bilinmiyor" gösterilir. */
const tl = (v: bigint): string => {
  try {
    return formatTL(tlFromChain(v));
  } catch {
    return T.unknown;
  }
};
const px = (v: bigint): string => {
  try {
    return formatPxTr(pxE6FromChain(v));
  } catch {
    return T.unknown;
  }
};
const execText = (status: number): string => {
  try {
    return EXEC_STATUS_TEXTS[execStatusFromChain(status)];
  } catch {
    return T.unknown;
  }
};

/** Zincirdeki uint8 ret kodu → ad + Türkçe metin. Bilinmeyen kod yine ret sayılır (kırmızı), "bilinmeyen ret kodu" yazılır. */
export function rejectInfo(code: number): { name: string | null; text: string } {
  try {
    const name = rejectCodeName(code);
    return { name, text: REJECT_TEXTS[name] };
  } catch {
    return { name: null, text: T.unknownReject };
  }
}

const when = (chain: ChainView, bn: bigint) => {
  const s = chain.blockTime(bn);
  return s === undefined ? `blok ${bn}` : trDateTime(secToMs(s));
};

function ChainLink({ hash, label }: { hash: string; label?: string }) {
  // zincir verisi her zaman gerçektir: bağlantı doğrudan Snowtrace'e gider
  return (
    <a className="mono" href={explorerTx(hash)} target="_blank" rel="noopener noreferrer">{label ?? short(hash)} ↗</a>
  );
}

/** Gövde ortak kapısı: kontrat/cüzdan yok, yükleniyor, okunamadı. Okunabilir olay varsa `ok` render eder. */
function Gated({ chain, children }: { chain: ChainView; children: (events: PlanEvent[]) => React.ReactNode }) {
  if (chain.gate !== "ready") return <GateNote gate={chain.gate} />;
  const { status, events } = chain.history;
  return (
    <>
      {status === "loading" && events.length === 0 && <div className="skeleton" style={{ marginTop: 14, height: 44 }} />}
      {status === "error" && <p className="hint pn-gray" role="status" style={{ marginTop: 10 }}>{T.noChain}</p>}
      {(status === "ok" || events.length > 0) && children(events)}
    </>
  );
}

/** Reddedilen girişimler: doğrudan zincirden (`BuyRejected`, user süzgeçli). Kırmızı yalnız bu kutuda ve ret satırlarındadır. */
export function RejectionsCard({ chain }: { chain: ChainView }) {
  return (
    <section className="card tilt-r" aria-label={T.rejLabel}>
      <Head label={T.rejLabel} mock={false} />
      <Gated chain={chain}>
        {(events) => {
          const rows = events.filter((e): e is Extract<PlanEvent, { kind: "BuyRejected" }> => e.kind === "BuyRejected").slice(0, LIMIT);
          return rows.length === 0 ? (
            <p className="hint" style={{ marginTop: 10 }}>{T.rejEmpty}</p>
          ) : (
            <div className="declist">
              {rows.map((e) => {
                const info = rejectInfo(e.code);
                return (
                  <article key={`${e.hash}-${e.code}-${e.amountTL}`} className="decision o-rejected">
                    <div className="between">
                      <span className="obadge o-rejected">RET</span>
                      <span className="hint mono">{when(chain, e.blockNumber)}</span>
                    </div>
                    <p className="dtitle pn-red">{info.text}</p>
                    <p className="hint">
                      {tl(e.amountTL)} TL · ajan #{e.agentId}
                      {info.name && <span className="mono"> · {info.name}</span>}
                    </p>
                    {info.name === "OVER_ORDER_LIMIT" && <p className="note" style={{ fontSize: 16, marginTop: 6 }}>{STOLEN_KEY_MESSAGE}</p>}
                    <p className="hint"><ChainLink hash={e.hash} /></p>
                  </article>
                );
              })}
            </div>
          );
        }}
      </Gated>
      <p className="hint" style={{ marginTop: 10 }}>{T.rejHint}</p>
    </section>
  );
}

/** İzinler ve emirler: `BuyAuthorized` + `BuyExecuted` eşleşmesi; rapor süresi geçen izin gri "rapor süresi doldu". */
export function ExecutionsCard({ chain, paper }: { chain: ChainView; paper: boolean }) {
  const kinds: BadgeKind[] = paper ? ["paper"] : [];
  return (
    <section className="card tilt-l" aria-label={T.actLabel}>
      <Head label={T.actLabel} kinds={kinds} mock={false} />
      <Gated chain={chain}>
        {(events) => {
          const rows = chain.authRows.slice(0, LIMIT);
          const closed = events.filter((e): e is Extract<PlanEvent, { kind: "CycleClosed" }> => e.kind === "CycleClosed").slice(0, 3);
          return rows.length === 0 && closed.length === 0 ? (
            <p className="hint" style={{ marginTop: 10 }}>{T.actEmpty}</p>
          ) : (
            <div className="declist">
              {rows.map((r) => {
                const ex = r.executed;
                return (
                  <article key={r.actionId} className={`decision ${ex ? "o-paid" : r.reportExpired ? "o-noted" : "o-held"}`}>
                    <div className="between">
                      <span className="label">İzin #{r.actionId}</span>
                      <span className="hint mono">{when(chain, r.authorized.blockNumber)}</span>
                    </div>
                    <p className="dtitle">{tl(r.authorized.amountTL)} TL</p>
                    {ex ? (
                      <p>
                        {execText(ex.status)} · {tl(ex.filledTL)} TL · ort. {px(ex.avgPxE6)}
                      </p>
                    ) : r.reportExpired ? (
                      <p className="pn-gray">{T.expired}</p>
                    ) : (
                      <p className="hint">{T.waitingExec}</p>
                    )}
                    <p className="hint">
                      <ChainLink hash={r.authorized.hash} label="izin" />
                      {ex && <> · <ChainLink hash={ex.hash} label="emir raporu" /></>}
                    </p>
                  </article>
                );
              })}
              {closed.map((c) => (
                <article key={`${c.hash}-${c.cycleId}`} className="decision o-noted">
                  <p className="label">{cycleName(c.cycleId)}</p>
                  <p>{c.ok ? T.cycleClosedOk : T.cycleClosedMiss} · {tl(c.spentTL)} TL</p>
                  <p className="hint"><ChainLink hash={c.hash} /></p>
                </article>
              ))}
            </div>
          );
        }}
      </Gated>
    </section>
  );
}
