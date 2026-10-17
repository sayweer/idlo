import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { PLAN_DRAFT_FIELDS, PlanDraftSchema, isPlanDraftSignable, type PlanDraft } from "@pilot/shared";
import {
  DEFAULT_LLM_MODEL,
  DRAFT_SOURCE_LABELS,
  PLAN_SYSTEM_PROMPT,
  PlanDraftError,
  llmModelFromEnv,
  numbersInText,
  planFromSentence,
  type PlanLlmClient,
} from "../src/plan/index.js";

/** §1'deki Elif cümlesi. */
const ELIF =
  "Maaşım ayın 1'inde yatıyor. 20 bininin en geç 5'ine kadar dolara çevrilmesini istiyorum. " +
  "Tek seferde 10 binden fazla harcama. Emin olmadığın bir şey olursa bana sor.";

/** §15 PlanDraft örneği. */
const draft15 = (): PlanDraft => ({
  cycleTL: { value: 20000, source: "user" },
  startDay: { value: 1, source: "user" },
  deadlineDay: { value: 5, source: "user" },
  maxOrderTL: { value: 10000, source: "user" },
  askOnAmbiguity: { value: true, source: "user" },
  maxWaitH: { value: 72, source: "default" },
  expiresInDays: { value: 90, source: "default" },
  questions: [],
});

type Reply = string | { text: string; stop?: Anthropic.StopReason } | Error;

function message(text: string, stop: Anthropic.StopReason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: DEFAULT_LLM_MODEL,
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

/** Sahte LLM: sıradaki cevabı verir, istekleri kaydeder. */
function fakeClient(replies: Reply[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: PlanLlmClient = {
    messages: {
      async create(body) {
        calls.push(body);
        const r = replies[calls.length - 1];
        if (r === undefined) throw new Error("beklenmeyen ek LLM çağrısı");
        if (r instanceof Error) throw r;
        return typeof r === "string" ? message(r) : message(r.text, r.stop);
      },
    },
  };
  return { client, calls };
}

const run = (sentence: string, replies: Reply[]) => {
  const f = fakeClient(replies);
  return { ...f, result: planFromSentence(sentence, { client: f.client, model: "test-model" }) };
};

async function expectPlanError(p: Promise<unknown>, kind: PlanDraftError["kind"]): Promise<PlanDraftError> {
  const err = await p.then(
    () => {
      throw new Error("hata bekleniyordu, taslak döndü");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlanDraftError);
  expect((err as PlanDraftError).kind).toBe(kind);
  return err as PlanDraftError;
}

describe("planFromSentence — sahte LLM", () => {
  it("L-1 Elif'in örnek cümlesi §15 PlanDraft değerlerini verir; istek §10.6'ya uyar", async () => {
    const { result, calls } = run(ELIF, [JSON.stringify(draft15())]);
    const d = await result;
    expect(d).toEqual(draft15());
    expect(isPlanDraftSignable(d)).toBe(true);
    expect(calls).toHaveLength(1);
    const body = calls[0]!;
    expect(body.model).toBe("test-model");
    expect(body.system).toBe(PLAN_SYSTEM_PROMPT);
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(body.messages)).toContain(ELIF);
    expect(body).not.toHaveProperty("tools");
  });

  it("L-1 her alan kaynağını taşır: senin cümlenden / varsayılan", async () => {
    const d = await run(ELIF, [JSON.stringify(draft15())]).result;
    const labels = PLAN_DRAFT_FIELDS.map((k) => DRAFT_SOURCE_LABELS[d[k].source]);
    expect(labels).toEqual([
      "senin cümlenden",
      "senin cümlenden",
      "senin cümlenden",
      "senin cümlenden",
      "senin cümlenden",
      "varsayılan",
      "varsayılan",
    ]);
  });

  it("L-2 \"Maaşımın çoğu\" → questions dolu, kart imzaya açılmaz", async () => {
    const s = "Maaşımın çoğunu ayın 1'i ile 5'i arasında dolara çevir. Tek seferde 10 binden fazla harcama.";
    const reply: PlanDraft = {
      ...draft15(),
      cycleTL: { value: null, source: "default" },
      askOnAmbiguity: { value: null, source: "default" },
      questions: ["Maaşının ne kadarını (kaç TL) çevirmek istiyorsun?", "Emin olunmayan durumda sana sorayım mı?"],
    };
    const d = await run(s, [JSON.stringify(reply)]).result;
    expect(d.cycleTL.value).toBeNull();
    expect(d.questions.length).toBeGreaterThan(0);
    expect(isPlanDraftSignable(d)).toBe(false);
  });

  it("L-2 LLM \"çoğu\"nu sayıya çevirse bile kod soruya çevirir", async () => {
    const s = "Maaşımın çoğunu ayın 1'i ile 5'i arasında dolara çevir. Tek seferde 10 binden fazla harcama. Emin değilsen sor.";
    const guess: PlanDraft = { ...draft15(), cycleTL: { value: 15000, source: "user" } };
    const d = await run(s, [JSON.stringify(guess)]).result;
    expect(d.cycleTL).toEqual({ value: null, source: "default" });
    expect(d.questions).toContain("Her ay kaç TL çevirmek istiyorsun?");
    expect(isPlanDraftSignable(d)).toBe(false);
  });

  it("L-3 cümlede olmayan sayı source:\"user\" olmaz (varsayılansız alan boşalır, varsayılanlı alan varsayılana döner; ikisinde de soru)", async () => {
    const invented: PlanDraft = {
      ...draft15(),
      maxOrderTL: { value: 5000, source: "user" }, // cümlede 5.000 yok
      maxWaitH: { value: 48, source: "user" }, // cümlede 48 yok
      expiresInDays: { value: 90, source: "user" }, // varsayılana eşit ama cümlede yok
    };
    const d = await run(ELIF, [JSON.stringify(invented)]).result;
    expect(d.maxOrderTL).toEqual({ value: null, source: "default" });
    expect(d.maxWaitH).toEqual({ value: 72, source: "default" });
    expect(d.expiresInDays).toEqual({ value: 90, source: "default" });
    expect(d.questions).toHaveLength(3);
    expect(isPlanDraftSignable(d)).toBe(false);
    const seen = numbersInText(ELIF);
    for (const k of PLAN_DRAFT_FIELDS) {
      const f = d[k];
      if (f.source === "user" && typeof f.value === "number") expect(seen.has(f.value)).toBe(true);
    }
    expect(PlanDraftSchema.safeParse(d).success).toBe(true);
  });

  it("L-3 Türkçe sayı sözcükleri ve rakam biçimleri tanınır", () => {
    expect([...numbersInText(ELIF)]).toEqual(expect.arrayContaining([1, 20000, 5, 10000]));
    expect(numbersInText("ayda yirmi beş bin lira, ayın beşine kadar").has(25000)).toBe(true);
    expect(numbersInText("ayda yirmi beş bin lira, ayın beşine kadar").has(5)).toBe(true);
    expect(numbersInText("20.000 TL, tek seferde 7.500").has(20000)).toBe(true);
    expect(numbersInText("20.000 TL, tek seferde 7.500").has(7500)).toBe(true);
    expect(numbersInText("1,5 bin TL").has(1500)).toBe(true);
    expect(numbersInText("iki yüz elli bin").has(250000)).toBe(true);
    expect(numbersInText("maaşımın çoğu, uygun zamanda").size).toBe(0);
  });

  it("L-4 bozuk JSON bir kez yeniden denenir ve ikinci geçerli çıktı döner", async () => {
    const { result, calls } = run(ELIF, ["{bozuk", JSON.stringify(draft15())]);
    expect(await result).toEqual(draft15());
    expect(calls).toHaveLength(2);
  });

  it("L-4 iki kez bozuk JSON → invalid_output; üçüncü çağrı ve yarım plan yok", async () => {
    const { result, calls } = run(ELIF, ["{bozuk", '{"cycleTL": {"value": 20000, "source": "user"}']);
    const err = await expectPlanError(result, "invalid_output");
    expect(calls).toHaveLength(2);
    expect(err.details).toHaveLength(2);
    expect(err.message).toMatch(/kural kartına çeviremedi/);
  });

  it("L-4 şemaya uymayan JSON (tavan > hedef, fazladan alan) da bozuk sayılır", async () => {
    const overCap = { ...draft15(), maxOrderTL: { value: 30000, source: "user" } };
    const extra = { ...draft15(), agent: "0x2222222222222222222222222222222222222222" };
    const { result, calls } = run(ELIF, [JSON.stringify(overCap), JSON.stringify(extra)]);
    await expectPlanError(result, "invalid_output");
    expect(calls).toHaveLength(2);
  });

  it("L-4 refusal ya da max_tokens yarım çıktı sayılır ve yeniden denenir", async () => {
    const half = JSON.stringify(draft15()).slice(0, 40);
    const { result, calls } = run(ELIF, [{ text: half, stop: "max_tokens" }, { text: "", stop: "refusal" }]);
    await expectPlanError(result, "invalid_output");
    expect(calls).toHaveLength(2);
  });

  it("L-4 LLM API'si çalışmıyor → llm_unavailable, yeni plan yok (§16 #13)", async () => {
    const down = new Anthropic.APIConnectionError({ message: "bağlantı yok" });
    const { result, calls } = run(ELIF, [down]);
    const err = await expectPlanError(result, "llm_unavailable");
    expect(calls).toHaveLength(1);
    expect(err.cause).toBe(down);
  });

  it("L-4 boş ya da çok uzun cümle LLM'e gitmez, invalid_input", async () => {
    const empty = run("   ", []);
    await expectPlanError(empty.result, "invalid_input");
    const long = run("a".repeat(501), []);
    await expectPlanError(long.result, "invalid_input");
    expect(empty.calls).toHaveLength(0);
    expect(long.calls).toHaveLength(0);
  });

  it("L-1 model LLM_MODEL'den gelir; yoksa Ek B varsayılanı", () => {
    expect(llmModelFromEnv({ LLM_MODEL: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(llmModelFromEnv({})).toBe("claude-sonnet-5-5");
    expect(llmModelFromEnv({ LLM_MODEL: "  " })).toBe(DEFAULT_LLM_MODEL);
  });
});

/**
 * [CANLI LLM] Gerçek Claude API'si; ANTHROPIC_API_KEY yoksa atlanır. Ücretlidir.
 * Çalıştırma: ANTHROPIC_API_KEY=... LLM_MODEL=... pnpm --filter pilot test
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("planFromSentence — [CANLI LLM]", () => {
  const deps = () => ({ client: new Anthropic(), model: llmModelFromEnv() });
  const LIVE_TIMEOUT = 120_000;

  it(
    "L-1 [CANLI LLM] Elif'in örnek cümlesi §15 PlanDraft değerlerini verir",
    async () => {
      const d = await planFromSentence(ELIF, deps());
      expect(d.cycleTL).toEqual({ value: 20000, source: "user" });
      expect(d.startDay).toEqual({ value: 1, source: "user" });
      expect(d.deadlineDay).toEqual({ value: 5, source: "user" });
      expect(d.maxOrderTL).toEqual({ value: 10000, source: "user" });
      expect(d.askOnAmbiguity).toEqual({ value: true, source: "user" });
      expect(d.maxWaitH).toEqual({ value: 72, source: "default" });
      expect(d.expiresInDays).toEqual({ value: 90, source: "default" });
    },
    LIVE_TIMEOUT,
  );

  it(
    "L-2 [CANLI LLM] \"Maaşımın çoğu\" → questions dolu",
    async () => {
      const d = await planFromSentence("Maaşımın çoğunu ay başında dolara çevir.", deps());
      expect(d.questions.length).toBeGreaterThan(0);
      expect(isPlanDraftSignable(d)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "L-3 [CANLI LLM] cümlede olmayan sayı source:\"user\" olmaz",
    async () => {
      const s = "Her ay 15 bin lirayı dolara çevir, acele etme.";
      const d = await planFromSentence(s, deps());
      const seen = numbersInText(s);
      for (const k of PLAN_DRAFT_FIELDS) {
        const f = d[k];
        if (f.source === "user" && typeof f.value === "number") expect(seen.has(f.value)).toBe(true);
      }
      expect(isPlanDraftSignable(d)).toBe(false); // gün aralığı ve tavan cümlede yok
    },
    LIVE_TIMEOUT,
  );
});
