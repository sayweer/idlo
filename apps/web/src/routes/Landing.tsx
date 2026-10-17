import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Link } from "react-router";
import { DATA_DISCLAIMER, ERC8004_FUJI, RejectCode, rejectText, STOLEN_KEY_MESSAGE } from "@pilot/shared";
import { Badges } from "../app/Badges";
import { initLanding } from "../landing/engine";
import "../landing/strings";
import { useDeployments } from "../lib/data";
import { short } from "../lib/format";
import { explorerAddress } from "../lib/fuji";
import { useLang } from "../lib/i18n";
import { Logo } from "../lib/Logo";
import "../styles/landing.css";
import "../styles/yetkiler.css";

const AVALANCHE_URL = "https://www.avax.network";
const ERC8004_URL = "https://eips.ethereum.org/EIPS/eip-8004";

type CardStyle = CSSProperties & { "--r": string };
/** Position + resting tilt for a pinned card. */
const at = (left: string | null, top: string | null, r: string, extra: CSSProperties = {}): CardStyle => ({
  ...(left ? { left } : {}),
  ...(top ? { top } : {}),
  "--r": r,
  ...extra,
});

type T = ReturnType<typeof useLang>["t"];

/** The agent's key file, torn in two: nothing in it caps what the agent may buy. */
function SheetHalf({ side, t }: { side: "l" | "r"; t: T }) {
  return (
    <div className={`half ${side}`} aria-hidden={side === "r" ? true : undefined}>
      <div className="tear">
        <div className="bar">
          <span>{t("l.sheet.file")}</span>
          <span>{t("l.sheet.edited")}</span>
        </div>
        <table>
          <tbody>
            <tr><td>{t("l.sheet.r1")}</td><td>{t("l.sheet.r1v")}</td><td className="q">{t("l.sheet.r1q")}</td></tr>
            <tr><td>{t("l.sheet.r2")}</td><td>{t("l.sheet.r2v")}</td><td className="q">{t("l.sheet.r2q")}</td></tr>
            <tr><td>{t("l.sheet.r3")}</td><td>{t("l.sheet.r3v")}</td><td className="q">{t("l.sheet.r3q")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Vote({ who, yes, label }: { who: string; yes: boolean; label: string }) {
  return (
    <div className="vote">
      {who}
      {yes && (
        <>
          <i className="splat" />
          <i className="stamp">{label}</i>
        </>
      )}
    </div>
  );
}

/** Remounts the whole board when the language changes so every scene rebuilds from the new text. */
export default function Landing() {
  const { lang } = useLang();
  return <Board key={lang} />;
}

function Board() {
  const root = useRef<HTMLDivElement>(null);
  const { t, lang } = useLang();
  const deployment = useDeployments();

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // the odometers read the page language while building; set it before the scenes are wired
    document.documentElement.lang = lang;
    document.body.classList.add("landing-body");
    const dispose = initLanding(el);
    return () => {
      dispose();
      document.body.classList.remove("landing-body");
    };
  }, [lang]);

  const yes = t("l.rules.yes");

  return (
    <div className="landing" ref={root}>
      <div className="cursor" aria-hidden="true"><i className="c-needle" /><i className="c-head" /></div>
      {/* every number on this page is a sample: the mode badge stays on screen while scrolling */}
      <div className="land-rozet"><Badges kinds={["mock"]} mock={false} /></div>

      <div className="strip">
        <div className="brand"><div className="tape" /><Logo size={24} /><b>Uçuş Planı</b><span>{t("l.tagline")}</span></div>
        <nav className="navcard" aria-label={t("l.nav.label")}>
          <a href="#but">{t("l.nav.why")}</a>
          <a href="#so">{t("l.nav.how")}</a>
          <a href="#rules">{t("l.nav.rules")}</a>
          <Link className="cta" to="/secim">{t("l.nav.open")}</Link>
        </nav>
      </div>

      {/* 1 · HERO — you write a sentence, the plan binds the agent and KULE */}
      <section className="scene" id="hero" data-scene="hero">
        <div className="stage" id="heroStage">
          <canvas className="threads" />
          <div className="hero-copy">
            <span className="eyebrow">{t("l.hero.eyebrow")}</span>
            <h1>
              <span className="line"><span>{t("l.hero.l1")}</span></span>
              <span className="line"><span>{t("l.hero.l2")}</span></span>
              <span className="line"><span><em>{t("l.hero.l3")}</em></span></span>
            </h1>
            <p className="lede">{t("l.hero.lede")}</p>
            <div className="btnrow">
              <Link className="btn" to="/secim">{t("l.hero.start")} <span className="arr">→</span></Link>
              <a className="btn ghost" href="#but">{t("l.hero.see")} <span className="arr">↓</span></a>
            </div>
          </div>

          {/* the sentence runs into the signed plan; the agent asks, KULE is the only hand that places an order */}
          <div className="card client kraft hc lift" id="cWeb" data-depth="1.25" data-bead={t("l.bead.client")} style={at("57vw", "11vh", "-2.5deg")}><i className="pin" /><span className="label">{t("l.client.you")}</span><div className="cname">{t("l.client.youName")}</div><span className="paylink">{t("l.client.youLink")}</span></div>
          <div className="card client kraft hc lift" id="cApi" data-depth=".9" style={at("78vw", "11vh", "2deg")}><i className="pin" /><span className="label">{t("l.client.pilot")}</span><div className="cname">{t("l.client.pilotName")}</div><span className="paylink">{t("l.client.pilotLink")}</span></div>
          <div className="card job hc lift" id="jWeb" data-depth=".95" style={at("56vw", "36vh", "2deg")}><i className="pin brass" /><span className="label">{t("l.job.plan")}</span><h4>{t("l.job.planName")}</h4><div className="jobamt">{t("l.job.planAmt")}</div><div className="who"><span className="chip">{t("l.job.planChip1")}</span><span className="chip">{t("l.job.planChip2")}</span></div></div>
          <div className="card job hc lift" id="jApi" data-depth="1.2" style={at("76vw", "39vh", "-3deg")}><i className="pin brass" /><span className="label">{t("l.job.kule")}</span><h4>{t("l.job.kuleName")}</h4><div className="jobamt">{t("l.job.kuleAmt")}</div><div className="who"><span className="chip">{t("l.job.kuleChip1")}</span><span className="chip">{t("l.job.kuleChip2")}</span></div></div>
          <div className="card member hc lift" id="mAli" data-depth="1.15" style={at("57vw", "66vh", "-4deg")}><i className="pin" /><div className="face">20K</div><div className="name">{t("l.limit.cycle")}</div><div className="role">{t("l.limit.cycleRole")}</div></div>
          <div className="card member hc lift" id="mAyse" data-depth=".8" style={at("71vw", "69vh", "3deg")}><i className="pin" /><div className="face" style={{ background: "#4a4239" }}>10K</div><div className="name">{t("l.limit.order")}</div><div className="role">{t("l.limit.orderRole")}</div></div>
          <div className="card member hc lift" id="mMeh" data-depth="1.3" style={at("85vw", "65vh", "-2deg")}><i className="pin" /><div className="face" style={{ background: "#7a4a22" }}>5.</div><div className="name">{t("l.limit.day")}</div><div className="role">{t("l.limit.dayRole")}</div></div>
        </div>
      </section>

      {/* 2 · BUT — the limit lives in the agent's own promise */}
      <section className="scene" id="but" data-scene="but">
        <div className="stage" id="butStage">
          <canvas className="threads" />
          <div className="card sticky bc lift" id="stA" style={at("8vw", "16vh", "-6deg")}><i className="pin" /><p className="note">{t("l.but.note1")}</p><span className="sig">— {t("l.but.sig")}</span></div>
          <div className="card sticky pink bc lift" id="stB" style={at("66vw", "10vh", "5deg")}><i className="pin" /><p className="note">{t("l.but.note2")}</p><span className="sig">— {t("l.but.sig")}</span></div>
          <div className="card sticky blue bc lift" id="stC" style={at("72vw", "44vh", "-3deg")}><i className="pin" /><p className="note">{t("l.but.note3")}</p></div>
          <div className="card sheet" id="sheet" style={at("31vw", "22vh", "-1.5deg")}>
            <i className="pin" id="sheetPin" />
            <SheetHalf side="l" t={t} />
            <SheetHalf side="r" t={t} />
          </div>
          <div data-split className="big-say but-title">{t("l.but.title.a")}<i>{t("l.but.title.em")}</i>{t("l.but.title.b")}</div>
        </div>
      </section>

      {/* 3 · SO — chat, signed plan, the chain's yes and no */}
      <section className="scene" id="so" data-scene="so">
        <div className="stage" id="soStage">
          <canvas className="threads" />
          <div data-split className="big-say so-title">{t("l.so.title")}</div>
          <div className="card invoice lift" id="inv" data-bead={t("l.bead.chat")} style={at("7vw", "12vh", "-2deg")}>
            <i className="pin" />
            <span className="label">{t("l.so.chat")}</span>
            <div className="row"><span className="note" style={{ fontSize: 19 }}>{t("l.so.chatNote")}</span><span className="amount">{t("l.so.chatAmt")}</span></div>
          </div>
          <div className="card job lift" id="soJob" style={at("12vw", "42vh", "1.5deg")}><i className="pin brass" /><span className="label">{t("l.so.matched")}</span><h4>{t("l.job.planName")}</h4><div className="who"><span className="chip">{t("l.job.planAmt")}</span><span className="chip">{t("l.job.planChip1")}</span></div></div>
          <div className="card reserve lift" id="res" data-bead={t("l.bead.cap")} style={at("38vw", "12vh", "-1deg")}><i className="pin" /><span className="label" style={{ position: "relative" }}>{t("l.so.reserve")}</span><span className="amount" style={{ position: "relative" }}><span className="odo" id="resAmt" data-max="20000" /> TL</span></div>
          <div className="card payee lift" id="pAli" data-bead={t("l.bead.allowed")} style={at("35vw", "50vh", "-3deg")}><i className="pin" /><span className="label">{t("l.so.allowed")}</span><div className="amount"><span className="odo" id="aliAmt" data-max="10000" /> TL</div><span className="chip paycur">{t("l.so.sent")}</span></div>
          <div className="card payee refused lift" id="pAyse" data-bead={t("l.bead.refused")} style={at("50vw", "56vh", "2.5deg")}><i className="pin" /><span className="label">{t("l.so.refused")}</span><div className="amount"><span className="odo" id="ayseAmt" data-max="15000" /> TL</div><span className="chip paycur">{rejectText(RejectCode.OVER_ORDER_LIMIT)}</span></div>
          <div className="burst" id="burst" />
          <div className="steps">
            <div className="step"><b>01</b><span>{t("l.so.step1")}</span></div>
            <div className="step"><b>02</b><span>{t("l.so.step2")}</span></div>
            <div className="step"><b>03</b><span>{t("l.so.step3")}</span></div>
            <div className="step"><b>04</b><span>{t("l.so.step4")}</span></div>
          </div>
          <div className="ptape" id="ptape" data-labels={t("l.so.ticks")} data-now="60%">
            <span className="label" style={{ position: "absolute", right: 18, top: -24, background: "var(--paper)", padding: "3px 8px", transform: "rotate(1deg)" }}>{t("l.so.period")}</span>
            <div className="ticks" />
            <div className="days" />
            <span className="now" />
            <span className="flag" id="fl1" style={{ left: "3%" }}>{t("l.so.flag1.t")}<b>{t("l.so.flag1.n")}</b>{t("l.so.flag1")}</span>
            <span className="flag" id="fl2" style={{ left: "31%" }}>{t("l.so.flag2.t")}<b>{t("l.so.flag2.n")}</b>{t("l.so.flag2")}</span>
            <span className="flag" id="fl3" style={{ left: "70%" }}>{t("l.so.flag3.t")}<b>{t("l.so.flag3.n")}</b>{t("l.so.flag3")}</span>
          </div>
        </div>
      </section>

      {/* 4 · RULES — the proof: a stolen agent key still hits the signed limit */}
      <section className="scene" id="rules" data-scene="rules">
        <div className="stage" id="rulesStage">
          <canvas className="threads" />
          <div data-split className="big-say rules-title">{t("l.rules.title")}</div>
          <div className="card ballot lift" id="ballot" style={at("7vw", "44vh", "-1.5deg")}>
            <i className="pin" />
            <span className="label">{t("l.rules.proposal")}</span>
            <span className="tally"><span className="odo" id="voteOdo" data-max="3" data-final="2" />/3</span>
            <h4>{t("l.rules.ask")}</h4>
            <div className="votes">
              <Vote who={t("l.rules.cap")} yes label={yes} /><Vote who={t("l.rules.id")} yes label={yes} /><Vote who={t("l.rules.order")} yes={false} label={yes} />
            </div>
            <span className="label needs">{t("l.rules.needs")}</span>
          </div>
          <div className="card sender kraft lift" id="sender" style={at("79vw", "40vh", "4deg")}><i className="pin" /><span className="label">{t("l.rules.thief")}</span><div className="amount">{t("l.rules.senderAmt")}</div></div>
          <div className="card agent lift" id="agent" style={at("50vw", "15vh", "2deg")}>
            <i className="pin brass" />
            <span className="label">{t("l.rules.agent")}</span>
            <p className="note" style={{ marginTop: 8 }}>{t("l.rules.agentNote")}</p>
          </div>
          <span className="held" id="held">{t("l.rules.held")}</span>
          <div className="card ruler" id="ruler" style={at("44vw", "58vh", "-1deg")}><i className="pin" /><span className="limitline" /><span className="needle" id="needle" /><span className="label">{t("l.rules.ruler")}</span><span className="limit">{t("l.rules.limit")}</span></div>
          <div className="card receipt" id="receipt" style={at("7vw", "76vh", ".6deg")}>
            <i className="pin brass" />
            <div className="ln" data-text={t("l.rules.log1")} />
            <div className="ln" data-text={t("l.rules.log2")} />
            <div className="ln" data-text={t("l.rules.log3")} />
            <div className="ln" data-text={`10:05  ${rejectText(RejectCode.OVER_ORDER_LIMIT)}`} />
          </div>
        </div>
      </section>

      {/* 5 · CLOSE — the key stays with you */}
      <section className="close" id="start">
        <div className="card close-card lift" id="closeCard" style={at(null, null, "-.8deg")}>
          <i className="pin" />
          <div className="card period" id="periodCard" style={at(null, null, "6deg")}><i className="pin brass" /><span className="label">{t("l.close.period")}</span><div className="amount" style={{ marginTop: 6 }}>{t("l.close.opens")}</div></div>
          <span className="label">{STOLEN_KEY_MESSAGE}</span>
          <h2 data-split style={{ marginTop: 18 }}>{t("l.close.title")}</h2>
          <p>{t("l.close.body")}</p>
          <div className="btnrow">
            <Link className="btn" to="/secim">{t("l.hero.start")} <span className="arr">→</span></Link>
            <Link className="btn ghost" to="/yetkiler">{t("l.close.limits")} <span className="arr">→</span></Link>
          </div>
        </div>
      </section>
      <footer className="foot">
        <div className="foot-grid">
          <div className="foot-brand">
            <Link to="/" className="foot-mark"><Logo size={40} dark /><b>Uçuş Planı</b></Link>
            <p>{t("l.scene")}</p>
            <span className="live"><i />{t("l.foot.live")}</span>
          </div>
          <nav className="foot-col" aria-label={t("l.foot.product")}>
            <h4>{t("l.foot.product")}</h4>
            <Link to="/secim">{t("l.start")} <span className="arr">→</span></Link>
            <Link to="/panel">{t("l.foot.panel")}</Link>
            <Link to="/yetkiler">{t("l.foot.limits")}</Link>
            <a href="#so">{t("l.foot.how")}</a>
          </nav>
          <nav className="foot-col" aria-label={t("l.foot.trust")}>
            <h4>{t("l.foot.trust")}</h4>
            {/* the contract link exists only when deployments/fuji.json parsed; until then it says so */}
            {deployment.status === "ready" ? (
              <a href={explorerAddress(deployment.deployments.flightPlan)} target="_blank" rel="noopener noreferrer">
                {t("l.foot.contract")} {short(deployment.deployments.flightPlan)} ↗
              </a>
            ) : (
              <span className="foot-note">{t("l.foot.noContract")}</span>
            )}
            <a href={explorerAddress(ERC8004_FUJI.identity)} target="_blank" rel="noopener noreferrer">{t("l.foot.identity")} ↗</a>
            <Link to="/ajan">{t("l.foot.agent")}</Link>
          </nav>
          <nav className="foot-col" aria-label={t("l.foot.source")}>
            <h4>{t("l.foot.source")}</h4>
            <a href={ERC8004_URL} target="_blank" rel="noopener noreferrer">ERC-8004 ↗</a>
            <a href={AVALANCHE_URL} target="_blank" rel="noopener noreferrer">Avalanche ↗</a>
          </nav>
        </div>
        <div className="foot-bottom"><span>{t("l.foot.legal")} · {DATA_DISCLAIMER}</span><span>{t("l.foot.chain")}</span></div>
      </footer>
    </div>
  );
}
