import type { ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import {
  AgentCardSchema,
  DATA_DISCLAIMER,
  ERC8004_FUJI,
  FUJI_AGENT_REGISTRY_ID,
  cardClaimsAgent,
  type AgentCard,
} from "@pilot/shared";
import "../styles/panel.css";
import { createChainReads, deploymentsOf, useDeployments } from "../lib/data";
import { short } from "../lib/format";
import { explorerAddress } from "../lib/fuji";
import { BADGE_TEXT } from "./Badges";
import { Shell } from "./Shell";
import { Row, UnknownBody } from "./panel/ui";

// ── agent.json ────────────────────────────────────────────────────────────────
type CardState =
  | { status: "none" } // 404 ya da SPA yedeği (HTML): henüz yayında değil
  | { status: "invalid"; message: string }
  | { status: "ready"; card: AgentCard; placeholder: boolean };

/** /agent.json'u okur ve genel şemayla doğrular. Kart güvenilmeyen veridir: yalnız biçim denetlenir, karar alınmaz. */
async function loadCard(): Promise<CardState> {
  let res: Response;
  try {
    res = await fetch("/agent.json", { cache: "no-store" });
  } catch (e) {
    return { status: "invalid", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 404) return { status: "none" };
  if (!res.ok) return { status: "invalid", message: `HTTP ${res.status}` };
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/html") || text.trimStart().startsWith("<")) return { status: "none" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "invalid", message: "geçerli JSON değil" };
  }
  const r = AgentCardSchema.safeParse(raw);
  if (!r.success) return { status: "invalid", message: r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") };
  return { status: "ready", card: r.data, placeholder: text.includes("ALANADI") };
}

const addr = (a: string) => (
  <a className="mono" href={explorerAddress(a)} target="_blank" rel="noopener noreferrer">{short(a)} ↗</a>
);

function Pending({ children }: { children: ReactNode }) {
  return <span className="pn-gray">{children}</span>;
}

/**
 * /ajan: PİLOT'un ERC-8004 kimliği, kayıt dosyası ve OKX.AI'da listelenebilir servis kartları (UI_HANDOFF §2.5).
 * Gerçek olan: Fuji ERC-8004 kayıt adresleri (sabit), deployments/fuji.json (adresler, agentId), /agent.json ve zincirdeki plan.
 * TEMSİLİ olan: Lira Hava Durumu servisinin ödeme adımı (TEMSİLİ ÖDEME) ve servis kartlarının canlı denemesi (PLANLI).
 * TODO(spec): "PİLOT'u puanla" (Reputation giveFeedback, OLURSA) bu ekranda yok; /servis ve /agent.json henüz yok (D4/A3).
 */
export default function Ajan() {
  const state = useDeployments();
  const dep = deploymentsOf(state);
  const { address } = useConnection();

  const cardQ = useQuery({ queryKey: ["ajan-card"], queryFn: loadCard, staleTime: 30_000, retry: false });
  const planQ = useQuery({
    queryKey: ["ajan-plan", dep?.flightPlan, address],
    queryFn: async () => (await createChainReads(dep!).readPlan(address!)).plan,
    enabled: !!dep && !!address,
    retry: false,
  });

  const agentId = dep?.agentId;
  return (
    <Shell badges={["mockPay"]}>
      <div className="card tape no-pin">
        <div className="label">/ajan</div>
        <h1 className="title" style={{ marginTop: 6 }}>PİLOT'un kimliği</h1>
        <p className="note" style={{ marginTop: 14 }}>
          Ajan, Fuji'deki ERC-8004 kaydıyla tanınır. Kimlik kartı herkese açık okunur; planın ajanı bu kimliğe bağlıdır.
        </p>
      </div>

      <section className="card agentcard" aria-label="ERC-8004 kimliği">
        <span className="label">ERC-8004 kimliği · Avalanche Fuji</span>
        <table className="facts" style={{ marginTop: 10 }}>
          <tbody>
            <Row k="agentId">
              {state.status === "none" ? (
                <Pending><span className="mono">NO_DEPLOYMENT</span> · kontrat henüz dağıtılmadı</Pending>
              ) : state.status === "invalid" ? (
                <Pending>Kontrat adresi okunamadı</Pending>
              ) : agentId ? (
                <b className="mono">#{agentId}</b>
              ) : (
                <Pending>kayıt bekleniyor</Pending>
              )}
            </Row>
            <Row k="Identity kaydı">{addr(ERC8004_FUJI.identity)}</Row>
            <Row k="agentRegistry"><span className="mono">{FUJI_AGENT_REGISTRY_ID}</span></Row>
            <Row k="Reputation kaydı">{addr(ERC8004_FUJI.reputation)}</Row>
            <Row k="PİLOT ajan adresi">{dep ? addr(dep.pilotAgent) : <Pending>kontrat adresi bekleniyor</Pending>}</Row>
            <Row k="KULE rapor adresi">{dep ? addr(dep.kuleReporter) : <Pending>kontrat adresi bekleniyor</Pending>}</Row>
            <Row k="Kayıt dosyası">
              <a className="mono" href="/agent.json" target="_blank" rel="noopener noreferrer">/agent.json ↗</a>
            </Row>
            {address && dep && (
              <Row k="Planındaki ajan">
                {planQ.isPending ? (
                  "…"
                ) : planQ.isError ? (
                  <Pending>Zincir okunamadı</Pending>
                ) : planQ.data ? (
                  <>
                    #{planQ.data.agentId} {addr(planQ.data.agent)}
                    {agentId !== undefined && <span className="hint"> · {planQ.data.agentId === agentId ? "PİLOT" : "PİLOT dışı bir ajan"}</span>}
                  </>
                ) : (
                  <Pending>Henüz bir Uçuş Planın yok · <Link to="/secim">ajan seç</Link></Pending>
                )}
              </Row>
            )}
          </tbody>
        </table>
      </section>

      <section className="card tilt-l" aria-label="Kayıt dosyası">
        <span className="label">agent.json</span>
        <CardBody q={cardQ} agentId={agentId} />
      </section>

      <div className="pn-svcs">
        <section className="card tilt-r" aria-label="Emir Denetimi">
          <div className="between pn-head">
            <span className="label">OKX.AI servisi</span>
            <span className="chip paid">ücretsiz</span>
          </div>
          <h2 className="h3" style={{ marginTop: 8 }}>Emir Denetimi</h2>
          <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.45 }}>
            Bir alış teklifini birimleriyle okur ve normalize eder; sonuç ONAY, DÜZELT ya da RET olur. Emir göndermez.
          </p>
          <table className="facts" style={{ marginTop: 10 }}>
            <tbody>
              <Row k="Uç"><span className="mono">POST /a2mcp/emir-denetimi</span></Row>
              <Row k="Ücret">ücretsiz</Row>
              <Row k="OKX.AI">OKX.AI'da listelenebilir</Row>
            </tbody>
          </table>
          <p style={{ marginTop: 12 }}>
            <button type="button" className="btn small ghost" disabled title="Canlı deneme henüz yok">Canlı deneme: planlı</button>
          </p>
        </section>

        <section className="card tilt-l" aria-label="Lira Hava Durumu servisi">
          <div className="between pn-head">
            <span className="label">OKX.AI servisi</span>
            <span className="chip">x402</span>
          </div>
          <h2 className="h3" style={{ marginTop: 8 }}>Lira Hava Durumu</h2>
          <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.45 }}>
            USDT-TRY fırtına sınıfı ve göstergeleri. Ajanlar için ücretli uçtur: önce 402 gelir, ödemeden sonra veri.
          </p>
          <p style={{ marginTop: 12 }}><span className="pn-bigstamp">{BADGE_TEXT.mockPay}</span></p>
          <table className="facts" style={{ marginTop: 10 }}>
            <tbody>
              <Row k="Uç"><span className="mono">GET /a2mcp/lira-hava-durumu</span></Row>
              <Row k="Ücret">ör. 0,01 USDG, temsili</Row>
              <Row k="OKX.AI">OKX.AI'da listelenebilir</Row>
            </tbody>
          </table>
          <ol className="pn-steps-num">
            <li>İstek <b>402</b> döner; <span className="mono">PAYMENT-REQUIRED</span> başlığında tutar, ağ ve alıcı olur.</li>
            <li>Ödeme imzalanıp <span className="mono">PAYMENT-SIGNATURE</span> ile tekrar denenir. Temsili modda imzayı servis taklit eder.</li>
            <li><b>200</b> ile <span className="mono">PAYMENT-RESPONSE</span>, veri ve uyarı gelir.</li>
          </ol>
          <p className="hint" style={{ marginTop: 10 }}>
            Türkiye'deki kullanıcılar için ücretsiz; ücret yalnız yurt dışındaki ajanlar için. Hukuki görüş değildir.
          </p>
          <p className="hint" style={{ marginTop: 6 }}>{DATA_DISCLAIMER}</p>
          <p style={{ marginTop: 12 }}>
            <button type="button" className="btn small ghost" disabled title="Canlı deneme henüz yok">Canlı deneme: planlı</button>
          </p>
        </section>
      </div>
    </Shell>
  );
}

function CardBody({ q, agentId }: { q: UseQueryResult<CardState>; agentId: string | undefined }) {
  if (q.isPending) return <div className="skeleton" style={{ marginTop: 14, height: 60 }} />;
  if (q.isError) return <UnknownBody note="agent.json okunamadı" />;
  const s = q.data;
  if (s.status === "none") return <UnknownBody note="agent.json henüz yayında değil." />;
  if (s.status === "invalid") return <UnknownBody note={`agent.json geçersiz: ${s.message}`} />;
  const { card } = s;
  const claims = agentId === undefined ? null : cardClaimsAgent(card, agentId, FUJI_AGENT_REGISTRY_ID);
  return (
    <>
      <h2 className="h3" style={{ marginTop: 8 }}>{card.name}</h2>
      <p style={{ marginTop: 6, fontSize: 14, lineHeight: 1.45 }}>{card.description}</p>
      <table className="facts" style={{ marginTop: 10 }}>
        <tbody>
          <Row k="etkin">{card.active ? "evet" : "hayır"}</Row>
          <Row k="servisler">
            {card.services.length === 0 ? "yok" : card.services.map((x) => <div key={x.name + x.endpoint} className="mono">{x.name} · {x.endpoint}</div>)}
          </Row>
          <Row k="güven">{card.supportedTrust.join(", ") || "yok"}</Row>
          <Row k="kayıtlar">
            {card.registrations.length === 0 ? (
              <Pending>kayıttan önce boş</Pending>
            ) : (
              card.registrations.map((r) => <div key={r.agentRegistry + r.agentId} className="mono">#{r.agentId} · {r.agentRegistry}</div>)
            )}
          </Row>
          <Row k="kimlik eşleşmesi">
            {claims === null ? <Pending>agentId bekleniyor</Pending> : claims ? "kart bu agentId'yi bu kayıtta kendi kaydı gösteriyor" : <Pending>kart bu agentId'yi göstermiyor</Pending>}
          </Row>
        </tbody>
      </table>
      {s.placeholder && <p className="hint pn-gray" style={{ marginTop: 8 }}>Kart hâlâ ALANADI yer tutucusu içeriyor: kayıttan önce gerçek adreslerle değişmeli.</p>}
      <p className="hint" style={{ marginTop: 8 }}>Kart güvenilmeyen veridir: yalnız biçimi doğrulandı, kimlik ve puan kararı karttan alınmaz.</p>
    </>
  );
}
