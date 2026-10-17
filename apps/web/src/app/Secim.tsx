import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { Candidate } from "@pilot/shared";
import { useDeployments } from "../lib/data";
import { useLang } from "../lib/i18n";
import { Shell } from "./Shell";
import type { BadgeKind } from "./Badges";
import { Candidates, ThresholdCard } from "./secim/Candidates";
import { ChatCard } from "./secim/ChatCard";
import { ConfirmWindow } from "./secim/ConfirmWindow";
import { DraftCard, ResultCard, type DraftView, type SignedResult } from "./secim/DraftCard";
import { getCandidates, getLlmAvailable, requestDraft } from "./secim/api";
import type { AgentsResponse } from "./secim/types";
import "./secim/strings";
import "../styles/secim.css";

type Answer = { question: string; answer: string };
type Search = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; data: AgentsResponse; message: string };
type Finished = { result: SignedResult | null; fallback: { hash: string; finalityMs: number } };

/**
 * /secim — ana sahne: sohbet → ERC-8004 adayları (kod elemesi, LLM sıralaması) → seçim → Uçuş Planı taslağı → onay penceresi → imza.
 * Aday listesi `/api/agents`, taslak `/api/plan/draft` (Cloudflare Pages Functions). İmza yalnız onay penceresinden yapılır.
 */
export default function Secim() {
  const { t } = useLang();
  const llmQ = useQuery({ queryKey: ["secim", "llm"], queryFn: getLlmAvailable, staleTime: 30_000, retry: false });
  const llm = llmQ.isPending ? null : (llmQ.data ?? false);
  const depState = useDeployments();

  const [message, setMessage] = useState("");
  const [search, setSearch] = useState<Search>({ status: "idle" });
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [answersSent, setAnswersSent] = useState(false);
  const [winOpen, setWinOpen] = useState(false);
  const [finished, setFinished] = useState<Finished | null>(null);
  const answersLog = useRef<Answer[]>([]);
  const seq = useRef(0); // eski cevapların yeni durumu ezmesini önler

  const reset = useCallback(() => {
    seq.current++;
    setPicked(null);
    setDraft(null);
    setAnswersSent(false);
    setWinOpen(false);
    setFinished(null);
    answersLog.current = [];
  }, []);

  const runSearch = async () => {
    const text = message.trim();
    if (text === "") return;
    reset();
    const mine = seq.current;
    setSearch({ status: "loading" });
    try {
      const data = await getCandidates(text);
      if (seq.current === mine) setSearch({ status: "ready", data, message: text });
    } catch (e) {
      console.error("secim: aday listesi alınamadı", e);
      if (seq.current === mine) setSearch({ status: "error" });
    }
  };

  const runDraft = useCallback(async (sentence: string) => {
    const mine = ++seq.current;
    setDraft({ status: "loading" });
    const r = await requestDraft(sentence, answersLog.current);
    if (seq.current !== mine) return;
    setAnswersSent(false);
    setDraft(r.ok ? { status: "ready", draft: r.draft } : { status: "error", kind: r.kind, message: r.message });
  }, []);

  const pick = (c: Candidate) => {
    if (search.status !== "ready" || llm !== true) return;
    answersLog.current = [];
    setFinished(null);
    setPicked(c);
    void runDraft(search.message);
  };

  const sendAnswers = (a: Answer[]) => {
    if (search.status !== "ready") return;
    const byQ = new Map(answersLog.current.map((x) => [x.question, x]));
    for (const x of a) byQ.set(x.question, x);
    answersLog.current = [...byQ.values()];
    setAnswersSent(true);
    void runDraft(search.message);
  };

  const ready = search.status === "ready" ? search.data : null;
  const pickReason = llm === false ? t("secim.cand.needLlm") : llm === null ? "…" : null;
  const signReason = depState.status === "loading" ? t("secim.draft.needDeps") : null;

  const badges: BadgeKind[] = [];
  if (ready?.origin === "fixture") badges.push("mock");
  if (llm === false) badges.push("rules");
  if (ready?.result.screen.kept.some((c) => c.demo)) badges.push("demo");

  return (
    <Shell badges={badges} side={ready ? <ThresholdCard thresholds={ready.thresholds} /> : undefined}>
      <ChatCard
        value={message}
        onChange={setMessage}
        onSubmit={() => void runSearch()}
        busy={search.status === "loading"}
        llm={llm}
        error={search.status === "error"}
      />

      {ready && (
        <Candidates
          result={ready.result}
          origin={ready.origin}
          pickedId={picked?.agentId ?? null}
          pickReason={pickReason}
          onPick={pick}
        />
      )}

      {ready && picked && draft && !finished && (
        <DraftCard
          agent={picked}
          origin={ready.origin}
          view={draft}
          answersSent={answersSent}
          onAnswers={sendAnswers}
          onRetry={() => search.status === "ready" && void runDraft(search.message)}
          onSign={() => setWinOpen(true)}
          signReason={signReason}
        />
      )}

      {finished && (
        <ResultCard
          result={finished.result}
          noEvent={finished.result ? null : finished.fallback}
          onAgain={() => {
            reset();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}

      {winOpen && ready && picked && draft?.status === "ready" && (
        <ConfirmWindow
          key={picked.agentId}
          draft={draft.draft}
          agent={picked}
          origin={ready.origin}
          onClose={() => setWinOpen(false)}
          onSigned={(result, fallback) => {
            setWinOpen(false);
            setFinished({ result, fallback });
          }}
        />
      )}
    </Shell>
  );
}
