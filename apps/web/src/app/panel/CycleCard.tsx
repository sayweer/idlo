import { Link } from "react-router";
import { cycleIdOf, formatTL, hoursToDeadline, trDay } from "@pilot/shared";
import { duration } from "../../lib/format";
import type { ChainView } from "./hooks";
import { cycleName } from "./time";
import { T } from "./text";
import { GateNote, Head, Row, UnknownBody } from "./ui";

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

/** Döngü çubuğu (zincirden): harcanan / hedef, bekleyen (reservedTL) ayrı dilim; pencere ve kalan süre TR saatiyle. */
export function CycleCard({ chain, nowSec }: { chain: ChainView; nowSec: number }) {
  const { gate, plan: ps, history } = chain;
  const closed = history.events.find((e) => e.kind === "CycleClosed" && e.cycleId === ps.cycle?.id);
  return (
    <section className="card tilt-l" aria-labelledby="pn-cycle">
      <Head label={T.cycleLabel} mock={false} />
      {gate !== "ready" ? (
        <GateNote gate={gate} />
      ) : ps.status === "loading" ? (
        <div className="skeleton" style={{ marginTop: 14, height: 44 }} />
      ) : ps.status === "error" || !ps.cycle ? (
        <UnknownBody note={T.noChain} />
      ) : !ps.plan ? (
        <div style={{ marginTop: 10 }}>
          <h2 className="h3" id="pn-cycle">{T.noPlan}</h2>
          <Link className="btn small" to="/secim" style={{ marginTop: 12 }}>{T.toSecim}</Link>
        </div>
      ) : (
        <CycleBody plan={ps.plan} cycle={ps.cycle} active={ps.active} nowSec={nowSec} closed={closed?.kind === "CycleClosed" ? closed : undefined} />
      )}
    </section>
  );
}

function CycleBody({
  plan,
  cycle,
  active,
  nowSec,
  closed,
}: {
  plan: NonNullable<ChainView["plan"]["plan"]>;
  cycle: NonNullable<ChainView["plan"]["cycle"]>;
  active: boolean;
  nowSec: number;
  closed?: { cycleId: number; ok: boolean };
}) {
  const target = plan.cycleTL;
  const spentPct = pct(cycle.spentTL, target);
  const resPct = Math.min(100 - spentPct, pct(cycle.reservedTL, target));
  const left = Math.max(0, target - cycle.spentTL - cycle.reservedTL);
  const day = trDay(nowSec);
  const hoursLeft = hoursToDeadline(nowSec, plan.deadlineDay);
  const phase = day < plan.startDay ? "pencere açılmadı" : hoursLeft <= 0 ? "pencere kapandı" : "pencere açık";
  const idNow = cycleIdOf(nowSec);
  const done = cycle.spentTL >= target;
  return (
    <>
      <h2 className="h3" id="pn-cycle" style={{ marginTop: 6 }}>{cycle.id !== 0 ? cycleName(cycle.id) : cycleName(idNow)}</h2>
      <p className="amount" style={{ marginTop: 8 }}>
        {formatTL(cycle.spentTL)} / {formatTL(target)}<small>TL</small>
      </p>
      <div className="gauge pn-gauge" role="img" aria-label={`${formatTL(cycle.spentTL)} TL ${T.spent}, ${formatTL(cycle.reservedTL)} TL ${T.reserved}, hedef ${formatTL(target)} TL`}>
        <i style={{ width: `${spentPct}%` }} />
        <i className="res" style={{ left: `${spentPct}%`, width: `${resPct}%` }} />
      </div>
      <p className="hint pn-legend">
        <span><b className="pn-key spent" />{T.spent} {formatTL(cycle.spentTL)}</span>
        <span><b className="pn-key res" />{T.reserved} {formatTL(cycle.reservedTL)}</span>
        <span>{T.remaining} {formatTL(left)} TL</span>
      </p>
      <table className="facts" style={{ marginTop: 12 }}>
        <tbody>
          <Row k={T.window}>
            ayın {plan.startDay}.–{plan.deadlineDay}. günü (TR saati) · bugün {day}. gün · {phase}
          </Row>
          {hoursLeft > 0 && <Row k="Son güne">{duration(Math.round(hoursLeft * 3600))}</Row>}
          <Row k="Tek emir tavanı">{formatTL(plan.maxOrderTL)} TL</Row>
        </tbody>
      </table>
      {!active && <p className="hint pn-gray" style={{ marginTop: 10 }}>{T.planInactive}</p>}
      {cycle.id === 0 && <p className="hint pn-gray" style={{ marginTop: 10 }}>{T.cycleNone}</p>}
      {done && <p className="note" style={{ marginTop: 12 }}>{T.goalDone}</p>}
      {closed && (
        <p className="hint" style={{ marginTop: 8 }}>{closed.ok ? T.cycleClosedOk : T.cycleClosedMiss}</p>
      )}
    </>
  );
}
