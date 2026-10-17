import { DATA_DISCLAIMER, WEATHER_CLASS_TEXTS, ZD_ALARM, formatPxTr, pxToPxE6, type Weather } from "@pilot/shared";
import type { BadgeKind } from "../Badges";
import { STALE_MS, type Loaded } from "./hooks";
import { trClockRelative, trDateTime, trNumber } from "./time";
import { T } from "./text";
import { Head, Row, UnknownBody } from "./ui";
import type { PilotFeed } from "../../lib/data";

/** Hava `px` ondalıklı number'dır; formatPxTr tamsayı pxE6 ister. Hata atarsa "bilinmiyor" (UI_HANDOFF §2.3). */
function pxText(px: number): string {
  try {
    return formatPxTr(pxToPxE6(String(px)));
  } catch {
    return T.unknown;
  }
}

/**
 * Lira Hava Durumu kutusu. Sınıfı UI hesaplamaz: sunucunun (PİLOT) değerini gösterir. Besleme yoksa/bayatsa gri
 * "bilinmiyor": "Hava açık" ya da yeşil asla varsayılan değildir (fail-closed).
 */
export function WeatherCard({ feed, now }: { feed: Loaded<PilotFeed>; now: number }) {
  const kinds: BadgeKind[] = [];
  let body: React.ReactNode;
  if (feed.status === "idle") {
    body = <UnknownBody note={T.noFeedUser} />;
  } else if (feed.status === "loading") {
    body = <div className="skeleton" style={{ marginTop: 14, height: 70 }} />;
  } else if (feed.status === "error") {
    body = <UnknownBody note={T.feedDown} />;
  } else {
    const f = feed.data;
    if (f.pilot.src === "replay") kinds.push("replay");
    const age = now - f.generatedAt;
    if (age > STALE_MS) body = <UnknownBody note={`${T.stale} (${Math.round(age / 60_000)} dk)`} />;
    else if (!f.pilot.alive) body = <UnknownBody note={T.pilotDead} />;
    else if (!f.weather) body = <UnknownBody />;
    else body = <WeatherBody w={f.weather} replay={f.pilot.src === "replay"} />;
  }
  return (
    <section className="card tilt-r" aria-label={T.weatherLabel}>
      <Head label={T.weatherLabel} kinds={kinds} />
      {body}
    </section>
  );
}

export function WeatherBody({ w, replay }: { w: Weather; replay: boolean }) {
  const alarm = w.zd >= ZD_ALARM;
  const ep = w.episode;
  return (
    <>
      <p className="pn-class" data-class={w.class}>{WEATHER_CLASS_TEXTS[w.class]}</p>
      <table className="facts" style={{ marginTop: 10 }}>
        <tbody>
          <Row k="zd">
            <span className={alarm ? "pn-red" : undefined}>{trNumber(w.zd, 1)}</span>
            {alarm && <> · <b className="pn-red">{T.alarm}</b> <span className="muted">(≥ {ZD_ALARM})</span></>}
          </Row>
          <Row k="BTC 1 sa / 3 sa">%{trNumber(w.btc1h)} / %{trNumber(w.btc3h)}</Row>
          <Row k={T.fx}>{w.fxOpen ? T.fxOpen : T.fxClosed}</Row>
          <Row k="USDT-TRY">{pxText(w.px)}</Row>
          <Row k={replay ? T.clockNote : "güncelleme"}>{trDateTime(w.ts)}</Row>
        </tbody>
      </table>
      {ep ? (
        <p className="reading">
          <span className="label">Fırtına bölümü</span>
          <span className="note" style={{ display: "block" }}>
            Fırtına başlangıcı {trClockRelative(ep.startTs, w.ts)}, en erken bitiş {trClockRelative(w.stormUntil ?? ep.endsAt, w.ts)}.
            Bitiş son alarmdan 6 sa sonradır; yeni alarm uzatır.
            {replay && <span className="hint"> ({T.clockNote})</span>}
          </span>
        </p>
      ) : (
        <p className="hint" style={{ marginTop: 10 }}>{T.noStorm}</p>
      )}
      {replay && <p className="hint" style={{ marginTop: 8 }}>{T.replayNote}</p>}
      <p className="hint" style={{ marginTop: 8 }}>{DATA_DISCLAIMER}</p>
    </>
  );
}
