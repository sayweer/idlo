# Claude Code'a verilecek ilk görevler

Hazırlık (bir kez, elle):
1. Boş bir klasörde `git init` yap.
2. `SPEC.md` dosyasını `docs/SPEC.md` olarak, `CLAUDE.md` dosyasını repo köküne koy.
3. Claude Code'u repo kökünde başlat.

---

## Görev 1 — İskelet (A0.1 + A0.2)

```
docs/SPEC.md §6.6, §7, §15 ve §17.2'deki A0 adımlarını ve CLAUDE.md'yi oku.
A0.1: pnpm monorepo iskeletini kur (apps/kule, apps/pilot, apps/servis, apps/web, packages/shared, contracts, data/replays, scripts, deployments).
packages/shared içine: units.ts (§7 birim kuralları), zod şemaları (§15: PlanDraft, Weather, Trace), ret kodları (§8.3), KULE verdict kodları (§9.2), Türkçe metinler.
Her uygulama için .env.example dosyalarını Ek B'ye göre oluştur.
A0.2: contracts/src/interfaces/IFlightPlan.sol (§8.1, v4.1 alanlarıyla: openBy, reportBy, PendingCleared), KULE araç şemaları (§9.1) ve PİLOT araç şemaları (§10.2) packages/shared altında.
Bitti sayılması için: pnpm -r build geçmeli. Anahtar ya da özel anahtar yazma.
SPEC'te olmayan bir karar gerekirse en dar seçeneği uygula ve TODO(spec) bırak.
```

## Görev 2 — Kontrat (A1) · Seyit

```
docs/SPEC.md §8.1–§8.4 ve CLAUDE.md'yi oku. contracts/src/FlightPlan.sol'u yaz (Pyth'siz; bandBps=0 desteklenir).
Mutlaka: setPlan sıkılık kuralı ve 24 saat kilit, her setPlan ve revoke bekleyen planı siler (PendingCleared),
requestBuy ret kodları (revert değil, BuyRejected + return 0; agent dışı çağıranda revert NotAgent),
openBy = now+15dk, reportBy = openBy+60dk, reportExecution openBy geçse de reportBy'a kadar kabul, filledTL ≤ amountTL (OverFilled),
expireAction yalnız reportBy sonrası, reservedTL muhasebesi, closeCycle, TR günü (Solady DateTimeLib, +3 saat).
Testler: SPEC §18'deki F-1…F-10 ve F-12…F-15; test adlarında kimlikleri kullan. forge test -vv geçmeli.
```

## Görev 3 — Lira Hava Durumu (C1) · Barış

```
docs/SPEC.md §11 ve §11.2'yi oku. apps/pilot içinde saf fonksiyon olarak hava durumu hesaplayıcısını ve fırtına bölümü kuralını yaz.
fxOpen'ı America/New_York saat dilimiyle hesapla (sabit ofset yok).
Testler: W-1…W-8 (§18). Test verisi için önce scripts/make-replay.ts'i yaz (OKX herkese açık history-candles, anahtarsız);
2024-08-05, 2025-03-19, 2025-10-10, 2025-12-02, 2026-02-01 günlerini data/replays altına indir.
Beklenen değerler §11.2'de (ör. 2024-08-05 P0=33,83; 01:40, 01:50, 02:15 UTC hâlâ KRIPTO_SISMESI).
```

## Görev 4 — KULE başlangıcı (B2–B3) · Bekir abi

```
Önce insan işi: SPEC §6.4 duman testleri ve B1 (CAA testi) elle çalıştırılır, sonuçlar ekibe yazılır.
Sonra: docs/SPEC.md §9 ve CLAUDE.md'yi oku. apps/kule içinde ATK'yı alt süreç olarak başlatan MCP istemcisini ve
Streamable HTTP MCP sunucusunu (bearer token, token→ajan bağı) kur; kule_status, kule_heartbeat, kule_market, kule_balance araçlarını yaz.
Test: U-1. Sonraki görev B4–B6 (kule_quote, kule_execute: kilit + diskte durum + tickSz + TOO_LATE, CAA döngüsü).
```

---

Her görev bittikten sonra bir sonraki adımı aynı kalıpla verin: *"docs/SPEC.md §X ve CLAUDE.md'yi oku. [Adım] görevini yap. Bitti sayılması için §18'deki [test kimlikleri] geçmeli."* Adım listesi ve sıra: SPEC §17.2, kontrol noktaları: §17.3.
