import { useConnection } from "wagmi";
import "../styles/panel.css";
import type { BadgeKind } from "./Badges";
import { Shell } from "./Shell";
import { ExecutionsCard, RejectionsCard } from "./panel/ChainCards";
import { CycleCard } from "./panel/CycleCard";
import { KuleCard, NoticesCard } from "./panel/KuleCard";
import { QuestionsCard } from "./panel/QuestionsCard";
import { TraceCard } from "./panel/TraceCard";
import { WeatherCard } from "./panel/WeatherCard";
import { useChain, useKuleStatus, useNow, usePilotFeed } from "./panel/hooks";
import { T } from "./panel/text";

/**
 * /panel: PİLOT'un turları, Lira Hava Durumu, döngü, sorular, retler ve KULE durumu tek ekranda (UI_HANDOFF §2.3).
 * Veri üç yerden gelir ve hiçbiri tahmin edilmez (fail-closed):
 *  - zincir (viem, user süzgeçli geçmiş + canlı izleme): döngü, reddedilen girişimler, izinler ve emirler
 *  - PİLOT beslemesi (adaptör): hava, iz, sorular; mock iken TEMSİLİ VERİ
 *  - KULE durumu (adaptör): sağlık, CAA, mod; mock iken TEMSİLİ VERİ
 */
export default function Panel() {
  const { address } = useConnection();
  const now = useNow(1000);
  const feed = usePilotFeed(address);
  const kule = useKuleStatus();
  const chain = useChain(address, Math.floor(now / 1000));

  // rail rozetleri: veri geldikçe KAYIT / KÂĞIT / DEMO … görünür (TEMSİLİ VERİ kendiliğinden eklenir)
  const badges: BadgeKind[] = [];
  if (feed.status === "ok") {
    if (feed.data.pilot.src === "replay") badges.push("replay");
    if (feed.data.pilot.mode === "rules") badges.push("rules");
    if (feed.data.pilot.injectionDemo) badges.push("injection");
  }
  if (kule.status === "ok") badges.push(kule.data.mode);

  return (
    <Shell
      badges={badges}
      side={
        <>
          <NoticesCard kule={kule} feed={feed} />
          <QuestionsCard feed={feed} now={now} />
          <RejectionsCard chain={chain} />
          <ExecutionsCard chain={chain} paper={kule.status === "ok" && kule.data.mode === "paper"} />
        </>
      }
    >
      <div className="card tape no-pin">
        <div className="label">{T.panelLabel}</div>
        <h1 className="title" style={{ marginTop: 6 }}>{T.panelTitle}</h1>
        <p className="note" style={{ marginTop: 14 }}>{T.panelNote}</p>
      </div>
      <CycleCard chain={chain} nowSec={Math.floor(now / 1000)} />
      <div className="grid2 pn-pair">
        <WeatherCard feed={feed} now={now} />
        <KuleCard kule={kule} now={now} />
      </div>
      <TraceCard feed={feed} now={now} />
    </Shell>
  );
}

