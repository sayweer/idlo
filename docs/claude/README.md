# Claude Code taşıma paketi (Seyit'in bilgisayarından)

Bu klasör, başka bir bilgisayarda Claude Code ile kaldığımız yerden devam etmek için gereken her şeyi taşır.

| Dosya | Ne | Yeni bilgisayarda ne yapılır |
|---|---|---|
| `GLOBAL_CLAUDE.md` | Seyit'in global çalışma kuralları (plan önce, step-by-step, ana ajan yönetir/alt ajanlar yapar, **Claude atıfı YASAK**, git kuralları) | O bilgisayarın sahibi kendi `~/.claude/CLAUDE.md`'sini kullanıyorsa **ezme**; içeriği oturumun başında okut (aşağıdaki başlangıç komutu bunu yapar). Kendi global dosyası yoksa `cp docs/claude/GLOBAL_CLAUDE.md ~/.claude/CLAUDE.md`. |
| `memory/*.md` | Önceki oturumun hafızası (kararlar, commit kuralı, UI sahibi, güvenlik açığı, pivot durumu) | Oturum başında okut. İstersen `~/.claude/projects/<repo-yolu>/memory/` altına kopyala. |
| `workflows/*.js` | Kullandığımız workflow şablonları (yaz → saldırgan test → 2 mercek inceleme → doğrulama → düzeltme). | `ROOT` sabitini yeni repo yoluna çevirip Workflow aracına `scriptPath` olarak ver ya da örnek al. `ajan-rehberi-arastirma.js` yarıda durduruldu — sıradaki iş bu. |

## Yeni oturumda yapıştırılacak başlangıç komutu

```
CLAUDE.md, docs/HANDOFF.md, docs/claude/GLOBAL_CLAUDE.md ve docs/claude/memory/*.md dosyalarını oku.
Bunlar önceki oturumun kuralları, kararları ve hafızası; aynen uygula (özellikle: ana oturum yönetir, kodu
alt ajanlar/workflow yazar; her anlamlı değişiklikte yerel commit, Barış + Bekir co-author satırları, Claude
atıfı YOK, push'u ben yaparım). Sonra docs/HANDOFF.md §6'daki sıradaki adımdan devam et: önce
ajan seçme sohbeti + ERC-8004 eşiği MVP'si için araştırmayı (docs/claude/workflows/ajan-rehberi-arastirma.js)
hafif bir workflow olarak yeniden çalıştır, sonucu bana özetle.
```

## Yeni bilgisayarda kontrol listesi

1. `git pull` → `pnpm install` → `pnpm -r build && pnpm -r test` → `cd contracts && forge test`.
2. `apps/pilot/.env`'yi `.env.example`'dan oluştur, `ANTHROPIC_API_KEY`'i yaz (repoda yok, olmamalı).
3. `git config user.name/user.email`'i kontrol et: commit'ler kimin adına atılacak? (Bu bilgisayarda author `sayweer <degirmenseyit@gmail.com>` idi; co-author satırları `memory/local-commit-policy.md`'de.)
