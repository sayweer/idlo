import { Link } from "react-router";
import { Shell } from "../app/Shell";
import { L } from "../landing/strings";
import { useLang } from "../lib/i18n";

// TODO: keyarc'ın sahne motoru (src/landing/engine.ts, rope.ts, odometer.ts, cursor.ts) ve landing.css bu ekranı
// dolduran ajan içindir. Motor keyarc'tan olduğu gibi kopyalandı; sahne kimlikleri (#hero, #but, #so …) ve içerik
// Uçuş Planı hikâyesine göre yeniden yazılacak.
export default function Landing() {
  const { t } = useLang();
  return (
    <Shell>
      <div className="card tape no-pin">
        <div className="label">Uçuş Planı</div>
        <h1 className="title" style={{ marginTop: 6 }}>{t(L("l.slogan"))}</h1>
        <p className="note" style={{ marginTop: 14 }}>{t(L("l.scene"))}</p>
        <div className="row" style={{ marginTop: 18, flexWrap: "wrap" }}>
          <Link className="btn" to="/secim">{t(L("l.start"))}</Link>
          <Link className="btn ghost" to="/panel">{t(L("l.open"))}</Link>
        </div>
      </div>
    </Shell>
  );
}
