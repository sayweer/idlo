// PİLOT — araç seçen ajan (SPEC §10) ve Lira Hava Durumu (SPEC §11). Çalıştırma: `pnpm --filter pilot dev`.
//
// Kayıt oynatma (REPLAY=data/replays/<gün>.json): simüle saat, FakeChain + FakeKule (kâğıt). Ağa hiçbir işlem gitmez.
// LLM_MODEL boşsa ya da LLM'e ulaşılamazsa turlar kural modunda çalışır ("LLM yok, kural modu").
// Canlı mod henüz yok: canlı Lira Hava Durumu kaynağı (KULE kule_market) B2'ye bağlı. TODO(spec)
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_LABELS, formatTL } from "@pilot/shared";
import { demoCalendarSource, readDemoCalendarFile } from "./calendar/index.js";
import { createAnthropicLlm, runReplaySim } from "./loop/index.js";
import { demoNewsSource, readDemoNewsFile } from "./news/index.js";
import { FileTraceStore } from "./trace/index.js";
import { readReplayFile } from "./weather/index.js";

/** Repo kökü (src/ ve dist/ aynı derinlikte). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Yol önce çalışma dizinine, yoksa repo köküne göre (CLAUDE.md komutu kökten yazılmış: data/replays/…). */
function resolveInput(p: string): string {
  const fromCwd = resolve(p);
  return existsSync(fromCwd) ? fromCwd : resolve(REPO_ROOT, p);
}

function fail(msg: string): never {
  console.error(`PİLOT başlamadı: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // apps/pilot/.env (Ek B). Zaten tanımlı ortam değişkenleri ezilmez. Değerler günlüğe yazılmaz.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = process.env;

  const injection = env.INJECTION_DEMO?.trim() ?? "";
  if (injection !== "" && injection !== "0" && injection !== "1") fail("INJECTION_DEMO 0 ya da 1 olmalı");
  // Kural 12: demo modu ekranda ve her iz kaydında etiketli; hiçbir korumayı kapatmaz (§10.5).
  const labels = injection === "1" ? [DEMO_LABELS.injectionDemo] : [];

  const replayPath = env.REPLAY?.trim();
  if (!replayPath) {
    fail("canlı mod henüz yok (canlı Lira Hava Durumu kaynağı yok). REPLAY=data/replays/<gün>.json ile çalıştırın.");
  }

  const llm = createAnthropicLlm(env.LLM_MODEL);
  const replay = await readReplayFile(resolveInput(replayPath));
  // §10.2: ATK news_* ve news_get_economic_calendar doğrulanmadı ([DOĞRULA], §21 #10) → etiketli demo akışı ve takvimi.
  // Gizli talimat yalnız INJECTION_DEMO=1 iken akışa girer (§10.5).
  const newsFile = await readDemoNewsFile(join(REPO_ROOT, "data/demo/news.json"));
  const calendarFile = await readDemoCalendarFile(join(REPO_ROOT, "data/demo/calendar.json"));
  const news = demoNewsSource(newsFile, { injection: injection === "1" });
  const calendar = demoCalendarSource(calendarFile);
  const traceDir = resolve(env.TRACE_DIR?.trim() || "data/traces");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const store = new FileTraceStore(join(traceDir, `replay-${replay.day}-${runId}.jsonl`));

  console.log(`PİLOT — KAYIT OYNATMA ${replay.day} · ${DEMO_LABELS.paperExec} (sahte zincir ve sahte KULE; ağa işlem gitmez)`);
  for (const l of labels) console.log(`ETİKET: ${l} (hiçbir kod korumasını kapatmaz)`);
  console.log(`Haber: ${newsFile.label} · Takvim: ${calendarFile.label} (güvenilmeyen/demo veri)`);
  console.log(llm ? `LLM: ${llm.model} (her tur bir Claude API çağrısı; ulaşılamazsa kural modu)` : `LLM: yok → ${DEMO_LABELS.rulesMode}`);
  console.log(`İz: ${store.path}`);

  const r = await runReplaySim({ replay, llm, store, labels, news, calendar, log: (l) => console.log(l) });
  const p = r.plan;
  console.log(
    `Bitti: ${r.records.length} tur. Döngü ${r.cycle.id}: harcanan ${formatTL(r.cycle.spentTL)} TL / hedef ${formatTL(p.cycleTL)} TL, ` +
      `ayrılmış ${formatTL(r.cycle.reservedTL)} TL; kâğıt emir: ${r.kule.executions.length}.`,
  );
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : "beklenmeyen hata"));
