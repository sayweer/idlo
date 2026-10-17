import type { ReactNode } from "react";
import { short } from "../../lib/format";
import { explorerTx } from "../../lib/fuji";
import { Badges, type BadgeKind } from "../Badges";
import { isMockFeed } from "../../lib/data/mode";
import { T } from "./text";

/** PİLOT/KULE mock beslemesi mi? Mock iken işlem özetleri gerçek zincirde yoktur: bağlantı verilmez. */
export const IS_MOCK = isMockFeed;

/** Kutu başlığı: sol etiket + sağda mod rozetleri. `mock=false`: kutu gerçek zincir verisi gösterir (TEMSİLİ VERİ eklenmez). */
export function Head({ label, kinds = [], mock = true }: { label: string; kinds?: BadgeKind[]; mock?: boolean }) {
  return (
    <div className="between pn-head">
      <span className="label">{label}</span>
      <Badges kinds={kinds} mock={mock} />
    </div>
  );
}

/** Gri "bilinmiyor" gövdesi: yeşil / "NORMAL" / "Hava açık" asla varsayılan değildir (fail-closed). */
export function UnknownBody({ note }: { note?: string }) {
  return (
    <div className="pn-unknown" role="status">
      <p className="mono pn-gray"><span className="status-dot" />{T.unknown}</p>
      {note && <p className="hint" style={{ marginTop: 6 }}>{note}</p>}
    </div>
  );
}

/** İşlem özeti: gerçek zincirde Snowtrace bağlantısı; mock beslemede düz metin (temsili işlem). */
export function TxRef({ hash, label }: { hash: string; label?: string }) {
  if (IS_MOCK) return <span className="mono pn-gray" title="temsili işlem">{label ?? short(hash)} · temsili</span>;
  return (
    <a className="mono" href={explorerTx(hash)} target="_blank" rel="noopener noreferrer">
      {label ?? short(hash)} ↗
    </a>
  );
}

/** Zincir tarafı kapıları (kontrat yok, cüzdan yok …) için ortak gri not. */
export function GateNote({ gate }: { gate: "loading" | "nodeploy" | "baddeploy" | "nowallet" }) {
  const text = gate === "nodeploy" ? T.noDeploy : gate === "baddeploy" ? T.badDeploy : gate === "nowallet" ? T.connect : "…";
  return (
    <p className="hint pn-gray" role="status" style={{ marginTop: 10 }}>
      {gate === "nodeploy" && <span className="mono">NO_DEPLOYMENT · </span>}
      {text}
    </p>
  );
}

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row">{k}</th>
      <td>{children}</td>
    </tr>
  );
}
