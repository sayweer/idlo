import { Link } from "react-router";
import { useDeployments } from "../lib/data";
import { explorerAddress } from "../lib/fuji";
import { useLang } from "../lib/i18n";
import { Logo } from "../lib/Logo";

/** A slim strip under every app page: the chain, the contract, the data disclaimer. */
export function AppFooter() {
  const { t } = useLang();
  const d = useDeployments();
  return (
    <footer className="appfoot">
      <Link to="/" className="appfoot-brand"><Logo size={22} /><b>Uçuş Planı</b><span>{t("tagline")}</span></Link>
      <nav aria-label="Uçuş Planı">
        {d.status === "ready" && (
          <a href={explorerAddress(d.deployments.flightPlan)} target="_blank" rel="noopener noreferrer">FlightPlan ↗</a>
        )}
        <span className="live"><i />{t("foot.chain")}</span>
        <span className="live">{t("foot.disclaimer")}</span>
      </nav>
    </footer>
  );
}
