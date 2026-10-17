import { useId } from "react";
import { useLang } from "../../lib/i18n";
import { Badge } from "../Badges";
import { MAX_MESSAGE_CHARS } from "./types";
import "./strings";

/** Sohbet kutusu: kullanıcı derdini ya da kurallarını yazar. LLM yoksa uyarı gösterilir; aday araması yine çalışır. */
export function ChatCard({
  value,
  onChange,
  onSubmit,
  busy,
  llm,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  /** null: henüz bilinmiyor. */
  llm: boolean | null;
  error: boolean;
}) {
  const { t } = useLang();
  const id = useId();
  const empty = value.trim().length === 0;
  return (
    <section className="card tape no-pin" aria-labelledby={`${id}-title`}>
      <div className="between">
        <span className="label">{t("secim.step.chat")}</span>
        {llm === false && <span className="rozetler"><Badge kind="rules" /></span>}
      </div>
      <h1 className="title" id={`${id}-title`} style={{ marginTop: 6 }}>{t("secim.title")}</h1>
      <p className="note" style={{ marginTop: 14 }}>{t("secim.lede")}</p>

      <form
        className="chat"
        onSubmit={(e) => {
          e.preventDefault();
          if (!empty && !busy) onSubmit();
        }}
      >
        <div className="field">
          <label className="label" htmlFor={`${id}-msg`}>{t("secim.chat.label")}</label>
          <textarea
            id={`${id}-msg`}
            className="input chat-input"
            rows={4}
            maxLength={MAX_MESSAGE_CHARS}
            value={value}
            placeholder={t("secim.chat.placeholder")}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty && !busy) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="between">
            <span className="hint">{t("secim.chat.hint")}</span>
            <span className="hint" aria-hidden="true">{t("secim.chat.count", { n: value.length, max: MAX_MESSAGE_CHARS })}</span>
          </div>
        </div>
        <div className="row chat-actions">
          <button className="btn" type="submit" disabled={empty || busy}>
            {busy ? t("secim.chat.going") : t("secim.chat.go")}
          </button>
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => onChange(t("secim.chat.placeholder"))}>
            {t("secim.chat.example")}
          </button>
        </div>
      </form>

      {llm === false && (
        <div className="reading" role="status">
          <div className="label">{t("secim.llm.none")}</div>
          <p className="hint" style={{ marginTop: 4 }}>{t("secim.llm.noneBody")}</p>
        </div>
      )}
      {error && (
        <div className="reading" role="alert">
          <div className="label">{t("secim.error")}</div>
          <p className="hint" style={{ marginTop: 4 }}>{t("secim.error.body")}</p>
        </div>
      )}
    </section>
  );
}
