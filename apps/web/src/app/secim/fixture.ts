import { getAddress } from "viem";
import {
  AGENT_CARD_TYPE_V1,
  FUJI_AGENT_REGISTRY_ID,
  MIN_FEEDBACK,
  MIN_SCORE,
  NEED_LIMITS,
  SelectionResultSchema,
  type AgentCard,
  type Candidate,
  type SelectionResult,
  type Thresholds,
} from "@pilot/shared";
import type { AgentsResponse } from "./types";

// TEMSİLİ VERİ: apps/pilot/src/directory arka ucu bağlanana kadar /api/agents bu etiketli örnek listeyi döner.
// Adresler belirgin sahte (0x…<n>), puanlar uydurmadır; ekran bu cevabı her zaman TEMSİLİ VERİ + DEMO ile gösterir.
// Eşik sonucu ve gerekçeler kodla elle kurulmuştur (eşik kodu pilot uygulamasındadır, web ondan içe aktarmaz).

const fakeAddr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

function card(id: number, name: string, description: string): AgentCard {
  return {
    type: AGENT_CARD_TYPE_V1,
    name,
    description,
    services: [],
    active: true,
    registrations: [{ agentId: id, agentRegistry: FUJI_AGENT_REGISTRY_ID }],
    supportedTrust: ["reputation"],
  };
}

function candidate(c: {
  id: number;
  name: string;
  description: string;
  clients: number[];
  feedback: number;
  /** Geri bildirim vermiş farklı doğrulanmış kullanıcı sayısı. */
  feedbackClients: number;
  score: number | null;
}): Candidate {
  return {
    agentId: String(c.id),
    demo: true,
    readFailed: false,
    hasIdentity: true,
    owner: fakeAddr(0x1000 + c.id),
    agentWallet: fakeAddr(0x2000 + c.id),
    card: card(c.id, c.name, c.description),
    cardIssueTr: null,
    verifiedClients: c.clients.map(fakeAddr),
    feedbackCount: c.feedback,
    feedbackClients: c.feedbackClients,
    score: c.score,
    issuesTr: [],
  };
}

/**
 * Fixture'ın eşikleri: tek müşterili demo için farklı müşteri alt sınırı 1'e gevşetildi (varsayılan 2); ekran bunu açıkça
 * belirtir (packages/shared/directory/schemas.ts MIN_VERIFIED_CLIENTS notu).
 */
export const FIXTURE_THRESHOLDS: Thresholds = { minFeedback: MIN_FEEDBACK, minScore: MIN_SCORE, minVerifiedClients: 1 };

/** İstemci özeti: kullanıcı metni 300 karakteri aşarsa kısaltılır (UserNeedSchema sınırı). */
function summaryOf(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > NEED_LIMITS.summary ? `${t.slice(0, NEED_LIMITS.summary - 1)}…` : t;
}

export function buildFixtureSelection(message: string): SelectionResult {
  const pilot = candidate({
    id: 17,
    name: "PİLOT",
    description: "Maaşı TL olarak yatıran kullanıcı için, imzalı kuralların içinde TL'yi USDT'ye çeviren ajan.",
    clients: [0xa1, 0xa2],
    feedback: 4,
    feedbackClients: 2,
    score: 95,
  });
  const demoA = candidate({
    id: 18,
    name: "Demo ajan A",
    description: "Aylık otomatik USDT alımı yapan örnek ajan.",
    clients: [0xb1],
    feedback: MIN_FEEDBACK,
    feedbackClients: 1,
    score: 80,
  });
  return SelectionResultSchema.parse({
    need: { summaryTr: summaryOf(message), keywords: [], amountTL: null, questions: [], source: "fallback" },
    screen: {
      kept: [pilot, demoA],
      eliminated: [
        {
          agentId: "19",
          demo: true,
          nameTr: "Demo ajan B",
          code: "TOO_FEW_FEEDBACK",
          reasonTr: `Doğrulanmış geri bildirim yetersiz: 0 geri bildirim, 0 farklı müşteri (en az ${MIN_FEEDBACK} geri bildirim ve ${FIXTURE_THRESHOLDS.minVerifiedClients} farklı müşteri gerekli; yalnız bu ajanla gerçekten işlem yapmış kullanıcılar sayılır).`,
        },
      ],
    },
    ranking: {
      source: "rule",
      items: [
        {
          agentId: "17",
          rationaleTr: "DEMO ajan. 2 farklı doğrulanmış müşteriden 4 geri bildirimle 95 puan.",
          source: "rule",
        },
        {
          agentId: "18",
          rationaleTr: "DEMO ajan. 1 farklı doğrulanmış müşteriden 3 geri bildirimle 80 puan.",
          source: "rule",
        },
      ],
    },
    notesTr: [
      "TEMSİLİ VERİ: aday listesi örnektir; ERC-8004 dizin servisi bağlanınca zincirden okunacak.",
      "LLM yok: sıralama ve gerekçeler puana göre, kodla yazıldı.",
    ],
  } satisfies SelectionResult);
}

export function buildFixtureResponse(message: string): AgentsResponse {
  return { origin: "fixture", thresholds: FIXTURE_THRESHOLDS, result: buildFixtureSelection(message) };
}
