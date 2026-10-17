import { HEALTH_TEXTS, MODE_LABELS, type KuleMode } from "@pilot/shared";
import type { KuleStatus, PilotFeed } from "../../lib/data";
import type { BadgeKind } from "../Badges";
import type { Loaded } from "./hooks";
import { T } from "./text";
import { spanText } from "./time";
import { reasonText, traceReasons } from "./trace";
import { Head, Row, UnknownBody } from "./ui";

/** Cancel-All-After süresi: KULE her 20 sn'de bir yeniler, OKX 60 sn yenilenmezse emirleri düşürür (SPEC §9.3). */
export const CAA_TIMEOUT_SEC = 60;
/** KULE durum yanıtının geçerlilik süresi (yoklama 3 sn): daha eskisi "bilinmiyor". TODO(spec): eşik SPEC'te yok. */
export const KULE_STALE_MS = 30_000;
/** PİLOT kalp atışı bu süreyi aşarsa KULE yeni emir almaz (SPEC §9.3). */
const HEARTBEAT_LIMIT_SEC = 45;

const modeKind = (m: KuleMode): BadgeKind => m;

/**
 * KULE durumu ve mod. Sağlık değerini UI tahmin etmez; veri yoksa ya da bayatsa gri "bilinmiyor".
 * CAA geri sayımı `lastRenewAt` + 60 sn'dir.
 * TODO(spec): lastRenewAt KULE'nin yerel saatidir; tarayıcı saatiyle kayma olabilir. kule_status `caa.timeoutSec` +
 * `serverNowMs` (ya da `cancelAt`) eklenince doğrudan o değer kullanılır (UI_HANDOFF §6.2 #3, Bekir).
 */
export function KuleCard({ kule, now }: { kule: Loaded<KuleStatus>; now: number }) {
  let body: React.ReactNode;
  let kinds: BadgeKind[] = [];
  if (kule.status === "loading" || kule.status === "idle") {
    body = <div className="skeleton" style={{ marginTop: 14, height: 80 }} />;
  } else if (kule.status === "error") {
    body = <UnknownBody note={T.kuleDown} />;
  } else if (now - kule.receivedAt > KULE_STALE_MS) {
    body = <UnknownBody note={T.stale} />;
  } else {
    kinds = [modeKind(kule.data.mode)];
    body = <KuleBody s={kule.data} now={now} />;
  }
  return (
    <section className="card tilt-r" aria-label={T.kuleLabel}>
      <Head label={T.kuleLabel} kinds={kinds} />
      {body}
    </section>
  );
}

export function KuleBody({ s, now }: { s: KuleStatus; now: number }) {
  const denied = s.health === "YETKİ_YOK"; // kırmızı yalnız ret/alarm: YETKİ_YOK alarmdır
  const left = s.caa.lastRenewAt === null ? null : CAA_TIMEOUT_SEC - (now - s.caa.lastRenewAt) / 1000;
  return (
    <>
      <p className={`pn-class${denied ? " pn-red" : ""}`}>{HEALTH_TEXTS[s.health]}</p>
      {s.reasons.length > 0 && (
        <ul className="pn-news">
          {s.reasons.map((r) => (
            <li key={r} className="hint">{reasonText(r)}</li>
          ))}
        </ul>
      )}
      <table className="facts" style={{ marginTop: 10 }}>
        <tbody>
          <Row k={T.mode}>{MODE_LABELS[s.mode]}</Row>
          <Row k={T.caa}>
            {!s.caa.active ? (
              T.caaInactive
            ) : left === null ? (
              `${T.caaActive} · ${T.unknown}`
            ) : left > 0 ? (
              `${T.caaActive} · yenilenmezse ${spanText(left)} sonra açık emirler düşer`
            ) : (
              T.caaLapsed
            )}
          </Row>
          <Row k={T.heartbeat}>
            {s.pilotHeartbeatAgeSec === null ? (
              T.unknown
            ) : (
              <>
                {Math.round(s.pilotHeartbeatAgeSec)} sn önce
                {s.pilotHeartbeatAgeSec > HEARTBEAT_LIMIT_SEC && <span className="hint"> · {HEARTBEAT_LIMIT_SEC} sn'yi aştı</span>}
              </>
            )}
          </Row>
          <Row k={T.dataAge}>
            {s.dataAgeSec.ticker === null && s.dataAgeSec.book === null
              ? T.unknown
              : `fiyat ${s.dataAgeSec.ticker === null ? T.unknown : `${Math.round(s.dataAgeSec.ticker)} sn`} · tahta ${s.dataAgeSec.book === null ? T.unknown : `${Math.round(s.dataAgeSec.book)} sn`}`}
          </Row>
          <Row k={T.block}>{s.chain.ok && s.chain.block !== null ? s.chain.block : T.chainDown}</Row>
        </tbody>
      </table>
    </>
  );
}

/**
 * Bildirimler: KULE gerekçelerinden (kule_status.reasons ve izdeki emri_uygula çıktısı) yalnız bakiye bildirimleri.
 * Boşken hiç görünmez.
 */
export function NoticesCard({ kule, feed }: { kule: Loaded<KuleStatus>; feed: Loaded<PilotFeed> }) {
  const codes = new Set<string>();
  if (kule.status === "ok") kule.data.reasons.forEach((r) => codes.add(r));
  if (feed.status === "ok") feed.data.traces.slice(0, 3).forEach((t) => traceReasons(t).forEach((r) => codes.add(r)));
  const notes = (["BALANCE_IN_FUNDING", "BALANCE"] as const).filter((c) => codes.has(c));
  if (notes.length === 0) return null;
  return (
    <section className="card kraft no-pin" aria-label="Bildirimler" role="status">
      <span className="label">Bildirimler</span>
      <ul className="pn-news">
        {notes.map((c) => (
          <li key={c} className="note" style={{ fontSize: 17 }}>{reasonText(c)}</li>
        ))}
      </ul>
    </section>
  );
}
