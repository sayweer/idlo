/**
 * KULE istemci arayüzü (§9.1). PİLOT KULE'ye yalnız bu arayüzle konuşur; LLM KULE araçlarını hiç görmez (§10.2).
 *
 * Her çağrıda (gerçek MCP istemcisi ve FakeKule için aynı yol):
 *   girdi  → paylaşılan KULE_TOOLS[ad].input ile doğrulanır (uymazsa KULE'ye hiç gitmez),
 *   çıktı  → KULE_TOOLS[ad].output ile doğrulanır (uymazsa KuleError; fail-closed, CLAUDE.md kural 2).
 */
import type { z } from "zod";
import { KULE_TOOLS, type KuleToolName } from "@pilot/shared";

type Def<N extends KuleToolName> = (typeof KULE_TOOLS)[N];
export type KuleInput<N extends KuleToolName> = z.input<Def<N>["input"]>;
export type KuleOutput<N extends KuleToolName> = z.output<Def<N>["output"]>;

export class KuleError extends Error {
  constructor(
    message: string,
    readonly tool: KuleToolName,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "KuleError";
  }
}

export interface KuleClient {
  status(): Promise<KuleOutput<"kule_status">>;
  heartbeat(): Promise<KuleOutput<"kule_heartbeat">>;
  market(input: KuleInput<"kule_market">): Promise<KuleOutput<"kule_market">>;
  balance(): Promise<KuleOutput<"kule_balance">>;
  quote(input: KuleInput<"kule_quote">): Promise<KuleOutput<"kule_quote">>;
  execute(input: KuleInput<"kule_execute">): Promise<KuleOutput<"kule_execute">>;
  cancel(input: KuleInput<"kule_cancel">): Promise<KuleOutput<"kule_cancel">>;
}

/**
 * safeParse, ama hiçbir zaman fırlatmaz. Neden: shared ActionIdSchema'nın refine'ı regex başarısız olsa da BigInt()
 * çağırıyor ve "abc" gibi girdide SyntaxError fırlatıyor (packages/shared/schemas/primitives.ts). Fırlayan doğrulama
 * da başarısız doğrulamadır (fail-closed).
 */
export function safeParseNoThrow<S extends z.ZodType>(schema: S, v: unknown): z.ZodSafeParseResult<z.output<S>> | { success: false; error: null } {
  try {
    return schema.safeParse(v);
  } catch {
    return { success: false, error: null };
  }
}

function issues(e: z.ZodError | null): string {
  if (e === null) return "doğrulama hata verdi";
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`)
    .join("; ");
}

/** Taşıma katmanından bağımsız doğrulayıcı taban. Alt sınıf yalnız `send`i yazar. */
export abstract class ValidatingKuleClient implements KuleClient {
  protected abstract send(name: KuleToolName, args: Record<string, unknown>): Promise<unknown>;

  protected async call<N extends KuleToolName>(name: N, input: unknown): Promise<KuleOutput<N>> {
    const def = KULE_TOOLS[name];
    const i = safeParseNoThrow(def.input, input);
    if (!i.success) throw new KuleError(`${name}: girdi şemaya uymuyor (${issues(i.error)})`, name);
    let raw: unknown;
    try {
      raw = await this.send(name, i.data as Record<string, unknown>);
    } catch (e) {
      if (e instanceof KuleError) throw e;
      throw new KuleError(`${name}: KULE'ye ulaşılamadı`, name, { cause: e });
    }
    const o = safeParseNoThrow(def.output, raw);
    if (!o.success) throw new KuleError(`${name}: KULE yanıtı şemaya uymuyor (${issues(o.error)})`, name);
    return o.data as KuleOutput<N>;
  }

  status() {
    return this.call("kule_status", {});
  }
  heartbeat() {
    return this.call("kule_heartbeat", {});
  }
  market(input: KuleInput<"kule_market">) {
    return this.call("kule_market", input);
  }
  balance() {
    return this.call("kule_balance", {});
  }
  quote(input: KuleInput<"kule_quote">) {
    return this.call("kule_quote", input);
  }
  execute(input: KuleInput<"kule_execute">) {
    return this.call("kule_execute", input);
  }
  cancel(input: KuleInput<"kule_cancel">) {
    return this.call("kule_cancel", input);
  }
}
