export const meta = {
  name: 'ajan-rehberi-arastirma',
  description: 'OKX.AI + ERC-8004 gerçeklerini doğrula; "sohbet → ERC-8004 eşikli ajan listesi → seçilen ajana Uçuş Planı" tasarımını mevcut koda oturt ve çürüt',
  phases: [
    { title: 'Research', detail: 'OKX.AI, ERC-8004 ABI/okuma, mevcut kodla uyum — paralel' },
    { title: 'Design', detail: 'akış, eşik, sıralama, KULE token, demo planı' },
    { title: 'Critique', detail: 'tasarımı çürüt, düzelt' },
  ],
}
const REPO = '/Users/seyit/Desktop/idlo'
const COMMON = `READ-ONLY with respect to ${REPO} (another workflow is editing it). Use WebSearch/WebFetch (load via ToolSearch) for external facts and cite URLs with dates; mark anything unverified as [DOĞRULA]. Prefer primary sources (okx.com, EIP text on eips.ethereum.org, github repos of the ERC-8004 reference implementation, ava-labs/8004-boilerplate). Never paste secrets.`

phase('Research')
const R = [
  { k: 'okxai', p: 'What exactly is OKX.AI (the OKX agent marketplace / "A2MCP" / task system)? How do developers list agents or services, how do users discover and use them, payments (x402?), which chain(s) (X Layer?), does it use ERC-8004 for identity/reputation, is there a public API/registry to enumerate listed agents and their metadata, and what is live today vs announced. Also what OKX Agent Trade Kit (ATK) is and whether third-party agents can trade on a user account without the user giving them keys. Read docs/SPEC.md §12, §8.5, §21 for what the team already assumed and confirm/refute each assumption.' },
  { k: 'erc8004', p: 'ERC-8004 (Trustless Agents): exact current interfaces of Identity, Reputation and Validation registries — function signatures for registering, reading agent URI/owner/agent wallet, giving feedback, and especially READING reputation (e.g. getSummary/readFeedback/getClients, filtering by client addresses, tags), and anti-sybil guidance in the spec. Check the official Fuji deployments in docs/SPEC.md §8.5/Ek B (0x8004A818…, 0x8004B663…, 0x8004Cb1B…) — use a public Fuji RPC (https://api.avax-test.network/ext/bc/C/rpc) with read-only eth_call / eth_getCode to confirm which functions exist (selectors) and whether any agents are registered (e.g. total supply / recent Registered events). Report an exact minimal ABI we can rely on.' },
  { k: 'kod-uyum', p: `Map how the proposed flow fits the CURRENT code in ${REPO}: contracts/src/interfaces/IFlightPlan.sol + FlightPlan.sol (plan.agent, agentId — can a plan name any agent address/agentId? what checks exist?), packages/shared/authz.ts (token→agent binding; what changes if KULE serves many agents with per-agent tokens), packages/shared/tools/kule.ts and pilot tools, apps/pilot planFromSentence and plan confirmation (packages/shared/plan if present), scripts/register-agent.ts (if present), docs/UI_HANDOFF.md. List precisely what is reusable as-is, what needs small changes, and what is new. Note SPEC §22 / CLAUDE.md conflicts (e.g. "iki kullanıcı", "anahtar tutan pazaryeri servisi").` },
]
const res = await parallel(R.map(r => () => agent(`${COMMON}\nTopic "${r.k}": ${r.p}\nReturn dense markdown with sources.`, { label: `araştır:${r.k}`, phase: 'Research' })))

phase('Design')
const design = await agent(`${COMMON}
Design (Turkish memo, identifiers English) the feature the team lead proposed: a chat where the user describes their need → system collects candidate agents (OKX.AI if enumerable, otherwise ERC-8004 Identity registry on Fuji + agent.json cards) → CODE (not LLM) filters by ERC-8004 identity + reputation threshold (define it: min score, min feedback count, only feedback from clients that actually used KULE — how KULE attests that) → LLM ranks remaining by fit with a Turkish reason per agent → user picks → existing flow: plan draft + confirmation popup ("zincire yazılacak değerler") → setPlan naming the chosen agent → agent works only via KULE → mutabakat.
Inputs:\n=== OKX.AI ===\n${res[0]}\n=== ERC-8004 ===\n${res[1]}\n=== KOD UYUMU ===\n${res[2]}
Memo sections: 1) OKX.AI gerçekte ne (doğrulanmış / [DOĞRULA]). 2) Akış (adım adım, her adımda kim karar veriyor: kod mu LLM mi). 3) ERC-8004 eşiği: tam kural + sybil önlemi + okuma ABI'si. 4) KULE çoklu ajan: ajan başına token, authz değişikliği, "KULE uyumlu ajan" standardı (ajanın uyması gereken minimal arayüz). 5) Demo planı: Fuji'de kaç demo ajanı, nasıl kaydedilip puanlanacak (DEMO etiketi), sahne akışı ve wow anları; mevcut §19 sahneleri nasıl korunur. 6) İş bölümü (Seyit kontrat+web?, Barış pilot/servis, Bekir KULE+UI) ve P0/P1/P2. 7) Riskler ve SPEC §22/CLAUDE.md çelişkileri, karar gerektirenler.`, { label: 'tasarım', phase: 'Design' })

phase('Critique')
const final = await agent(`${COMMON}\nAdversarially review this design: is every OKX.AI/ERC-8004 claim sourced? Can the threshold be gamed? Does any security decision leak to the LLM? Does it break the existing guarantees (signed limits, KULE authz, 24h loosening lock)? Is the demo achievable today given KULE isn't built yet? Then output the CORRECTED memo in full (Turkish) + a short "Düzeltilenler" list.\n\nMEMO:\n${design}`, { label: 'eleştiri', phase: 'Critique' })
return final
