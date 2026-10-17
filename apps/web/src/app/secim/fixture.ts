import { getAddress } from "viem";
import {
  AGENT_CARD_TYPE_V1,
  FUJI_AGENT_REGISTRY_ID,
  MIN_FEEDBACK,
  NEED_LIMITS,
  SelectionResultSchema,
  type AgentCard,
  type Candidate,
  type SelectionResult,
} from "@pilot/shared";

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
    score: c.score,
    issuesTr: [],
  };
}

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
    score: 95,
  });
  const demoA = candidate({
    id: 18,
    name: "Demo ajan A",
    description: "Aylık otomatik USDT alımı yapan örnek ajan.",
    clients: [0xb1],
    feedback: MIN_FEEDBACK,
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
          reasonTr: `Doğrulanmış geri bildirim yetersiz: 0 (en az ${MIN_FEEDBACK} gerekli; yalnız bu ajanla gerçekten işlem yapmış kullanıcılar sayılır).`,
        },
      ],
    },
    ranking: {
      source: "rule",
      items: [
        {
          agentId: "17",
          rationaleTr: "TL'yi USDT'ye çevirmek için kurulmuş; 2 doğrulanmış kullanıcıdan 95 puan almış.",
          source: "rule",
        },
        {
          agentId: "18",
          rationaleTr: "Aylık USDT alımına uygun; tek doğrulanmış kullanıcıdan 80 puan almış.",
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
