/** Dizin hataları: `message` kullanıcıya gösterilebilir Türkçe metindir; ayrıntı yalnız günlük içindir. */
export type DirectoryErrorKind = "invalid_input" | "unknown_agent" | "agent_not_eligible" | "plan_not_buildable";

const TEXTS: Record<DirectoryErrorKind, string> = {
  invalid_input: "Mesaj boş olamaz ve çok uzun olamaz.",
  unknown_agent: "Seçilen ajan aday listesinde yok.",
  agent_not_eligible: "Seçilen ajan eşiği geçemedi; onunla plan kurulamaz.",
  plan_not_buildable: "Seçilen ajan için plan taslağı kurulamadı.",
};

export class DirectoryError extends Error {
  readonly kind: DirectoryErrorKind;
  readonly details: readonly string[];
  constructor(kind: DirectoryErrorKind, details: readonly string[] = []) {
    super(TEXTS[kind]);
    this.name = "DirectoryError";
    this.kind = kind;
    this.details = details;
  }
}
