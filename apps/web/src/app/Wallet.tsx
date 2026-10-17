import type { ReactNode } from "react";
import { Link } from "react-router";
import { useConnect, useConnection, useDisconnect } from "wagmi";
import { short } from "../lib/format";
import { useLang } from "../lib/i18n";
import { Logo } from "../lib/Logo";
import { useFujiGuard } from "../lib/tx";

export function Wallet() {
  const { address, isConnected } = useConnection();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { onFuji, switchToFuji } = useFujiGuard();
  const { t } = useLang();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <div className="card tilt-r pin-gold">
        <div className="label">{t("wallet.label")}</div>
        <p className="note" style={{ margin: "8px 0 14px" }}>{t("wallet.pitch")}</p>
        <button className="btn" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
          {isPending ? t("wallet.opening") : t("wallet.connect")}
        </button>
        {!injected && <p className="hint" style={{ marginTop: 10 }}>{t("wallet.noExtension")}</p>}
      </div>
    );
  }
  return (
    <div className="card tilt-r pin-gold">
      <div className="between">
        <span className="label">{t("wallet.label")}</span>
        <button className="btn ghost small" onClick={() => disconnect()}>{t("wallet.unpin")}</button>
      </div>
      <div className="mono" style={{ marginTop: 8 }}>{short(address)}</div>
      {onFuji ? (
        <p className="hint" style={{ marginTop: 8 }}>{t("wallet.onFuji")}</p>
      ) : (
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => switchToFuji()}>{t("wallet.switch")}</button>
      )}
    </div>
  );
}

/**
 * Wraps a signing button: not connected → hint, wrong chain → switch button (signing stays closed), otherwise the button.
 * Not red: a wrong network is not a refusal (red means a rejection or an alarm only).
 */
export function OnFuji({ children }: { children: ReactNode }) {
  const { isConnected, onFuji, switchToFuji } = useFujiGuard();
  const { t } = useLang();
  if (!isConnected) return <span className="hint">{t("wallet.needConnect")}</span>;
  if (!onFuji) return <button className="btn small" onClick={() => switchToFuji()}>{t("wallet.switch")}</button>;
  return <>{children}</>;
}

export function Brand() {
  const { t } = useLang();
  return (
    <div className="brandrow">
      <Link className="brand" to="/">
        <Logo size={26} />
        <b>Uçuş Planı</b>
        <span>{t("tagline")}</span>
      </Link>
    </div>
  );
}
