import { useState } from "react";
import { useConnection, useSignMessage } from "wagmi";
import type { PilotAnswer, PilotFeed } from "../../lib/data";
import { STALE_MS, pilotSource, type Loaded } from "./hooks";
import { T } from "./text";
import { spanText } from "./time";
import { optionLabel } from "./TraceCard";
import { Head, UnknownBody } from "./ui";

type Question = PilotFeed["questions"][number];

/**
 * PİLOT'un soruları: soru metni, 2–4 seçenek düğmesi ve duvar saatiyle geri sayım. Cevap, bağlı cüzdanın
 * `{questionId, optionId, ts}` imzasıdır (fail-closed: imza yoksa cevap yok). Cevap uç noktası PLANLI olduğundan
 * `pilotSource.answer` yoksa düğme yalnız "iletilmedi" notu verir; hiçbir şey gönderilmiş gibi gösterilmez.
 * TODO(spec): POST /api/pilot/answer ve imza biçimi Barış ile kesinleşecek (UI_HANDOFF §2.3).
 */
export function QuestionsCard({ feed, now }: { feed: Loaded<PilotFeed>; now: number }) {
  const { address } = useConnection();
  const { mutateAsync: signMessage } = useSignMessage();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const note = (id: string, text: string) => setNotes((n) => ({ ...n, [id]: text }));

  async function answer(q: Question, optionId: string) {
    if (!pilotSource.answer) return note(q.questionId, T.qNoEndpoint);
    if (!address) return note(q.questionId, T.qNeedWallet);
    setBusy(q.questionId);
    try {
      note(q.questionId, T.qSign);
      const ts = Date.now();
      const signature = await signMessage({ message: JSON.stringify({ questionId: q.questionId, optionId, ts }) });
      const payload: PilotAnswer & { ts: number; signature: string } = { questionId: q.questionId, optionId, ts, signature };
      await pilotSource.answer(payload);
      note(q.questionId, T.qAnswered);
    } catch {
      note(q.questionId, T.qFail);
    } finally {
      setBusy(null);
    }
  }

  let body: React.ReactNode;
  if (feed.status === "idle") body = <UnknownBody note={T.noFeedUser} />;
  else if (feed.status === "loading") body = <div className="skeleton" style={{ marginTop: 14, height: 60 }} />;
  else if (feed.status === "error" || now - feed.data.generatedAt > STALE_MS) body = <UnknownBody note={feed.status === "error" ? T.feedDown : T.stale} />;
  else {
    const open = feed.data.questions.filter((q) => !q.answered);
    body =
      open.length === 0 ? (
        <p className="hint" style={{ marginTop: 10 }}>{T.qEmpty}</p>
      ) : (
        <div className="declist">
          {open.map((q) => {
            const left = Math.round((q.timeoutAt - now) / 1000);
            return (
              <article key={q.questionId} className="decision o-held">
                <p className="note" style={{ fontSize: 18 }}>{q.soru}</p>
                <div className="pn-qopts">
                  {q.secenekler.map((id) => (
                    <button key={id} type="button" className="btn small" disabled={busy === q.questionId || left <= 0} onClick={() => void answer(q, id)}>
                      {optionLabel(id)}
                    </button>
                  ))}
                </div>
                <p className="hint" style={{ marginTop: 10 }}>
                  {left > 0
                    ? `${spanText(left)} içinde cevap gelmezse: ${optionLabel(q.defaultOptionId)}`
                    : T.qTimeout}
                </p>
                {notes[q.questionId] && <p className="hint pn-gray" role="status">{notes[q.questionId]}</p>}
              </article>
            );
          })}
        </div>
      );
  }
  return (
    <section className="card tilt-l" aria-label={T.qLabel}>
      <Head label={T.qLabel} />
      {body}
      <p className="hint" style={{ marginTop: 10 }}>Cevap yeni bir tur başlatır.</p>
    </section>
  );
}
