/** Bearer token çözümü: sabit zamanlı karşılaştırma (erken çıkış yok), token → ajan bağı (§9.2-1). */
import { createHash, timingSafeEqual } from "node:crypto";
import type { TokenBinding } from "./config.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

export class TokenRegistry {
  private readonly entries: { digest: Buffer; binding: TokenBinding }[];

  constructor(bindings: readonly TokenBinding[]) {
    this.entries = bindings.map((b) => ({ digest: sha(b.token), binding: b }));
  }

  /** Geçerli token'ın bağını döndürür; değilse null. Tüm kayıtlar her zaman taranır (süre token'a bağlı değil). */
  resolve(candidate: string | null | undefined): TokenBinding | null {
    const d = sha(typeof candidate === "string" ? candidate : "");
    let found: TokenBinding | null = null;
    for (const e of this.entries) {
      if (timingSafeEqual(d, e.digest) && found === null) found = e.binding;
    }
    return found;
  }

  /** Kalp atışı sayılan (ajana bağlı) token adları. */
  agentLabels(): string[] {
    return this.entries.filter((e) => e.binding.agent !== null).map((e) => e.binding.label);
  }
}

/** "Authorization: Bearer x" → x (yoksa null). */
export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer (\S+)$/.exec(header);
  return m ? m[1]! : null;
}
