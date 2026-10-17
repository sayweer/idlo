import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useDeployments } from "../lib/data";
import { useLang } from "../lib/i18n";
import { short } from "../lib/format";
import { explorerAddress } from "../lib/fuji";
import { Badges, type BadgeKind } from "./Badges";
import { Brand, Wallet } from "./Wallet";

const NAV = [
  { to: "/secim", key: "nav.secim" },
  { to: "/panel", key: "nav.panel" },
  { to: "/yetkiler", key: "nav.yetkiler" },
  { to: "/ajan", key: "nav.ajan" },
] as const;

/**
 * Kontrat adresi durumu: dosya yoksa NO_DEPLOYMENT, okunamazsa "Kontrat adresi okunamadı". İkisinde de imza kapalı;
 * ekranlar `useDeployments()` ile aynı durumu okuyup düğmelerini kapatır.
 */
export function DeploymentCard() {
  const d = useDeployments();
  const { t } = useLang();
  return (
    <div className="card tilt-l no-pin kraft" role="status">
      <div className="label">{t("dep.label")}</div>
      {d.status === "loading" && <p className="mono" style={{ marginTop: 8 }}>…</p>}
      {d.status === "none" && (
        <>
          <p className="mono" style={{ marginTop: 8 }}><span className="status-dot" />NO_DEPLOYMENT</p>
          <p className="hint" style={{ marginTop: 6 }}>{t("dep.none")}</p>
        </>
      )}
      {d.status === "invalid" && (
        <>
          <p className="mono" style={{ marginTop: 8 }}><span className="status-dot" />{t("dep.invalid")}</p>
          <p className="hint" style={{ marginTop: 6 }}>{d.message}</p>
        </>
      )}
      {d.status === "ready" && (
        <>
          <p className="mono" style={{ marginTop: 8 }}><span className="status-dot ready" />{t("dep.ready")}</p>
          <a className="hint" href={explorerAddress(d.deployments.flightPlan)} target="_blank" rel="noopener noreferrer">
            FlightPlan {short(d.deployments.flightPlan)} ↗
          </a>
        </>
      )}
    </div>
  );
}

/** Tüm uygulama ekranlarının ortak iskeleti: sol rail (marka, cüzdan, gezinme), orta içerik, isteğe bağlı sağ kolon. */
export function Shell({ children, side, badges }: { children: ReactNode; side?: ReactNode; badges?: BadgeKind[] }) {
  const { t } = useLang();
  return (
    <div className="board">
      <aside className="rail">
        <Brand />
        <Badges kinds={badges} />
        <Wallet />
        <div className="card no-pin">
          <nav className="railnav" aria-label={t("nav.label")} style={{ marginTop: 0 }}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "on" : "")}>{t(n.key)}</NavLink>
            ))}
          </nav>
        </div>
        <DeploymentCard />
      </aside>
      <main className="main">{children}</main>
      {side && <aside className="side">{side}</aside>}
    </div>
  );
}

/** Placeholder ekranların ortak gövdesi: başlık, kısa not ve bağlanacak veri kaynağı. Ekranı dolduran ajan bunu siler. */
export function Placeholder({ label, title, note }: { label: string; title: string; note: string }) {
  return (
    <div className="card tape no-pin">
      <div className="label">{label}</div>
      <h1 className="title" style={{ marginTop: 6 }}>{title}</h1>
      <p className="note" style={{ marginTop: 14 }}>{note}</p>
    </div>
  );
}
