# contracts — Uçuş Planı (Foundry, Fuji)

Tek doğru kaynak: `../docs/SPEC.md` §8.

## Kurulum

Solidity bağımlılıkları pnpm çalışma alanından npm paketi olarak gelir (`lib/` ve `forge install` kullanılmaz).
Sürümler `package.json`'da tam olarak sabitlidir, `pnpm-lock.yaml` ile kilitlidir:

| Paket | Sürüm | Kaynak |
|---|---|---|
| `@openzeppelin/contracts` | 5.7.0 | npm |
| `solady` | 0.1.26 | npm |
| `forge-std` | v1.17.0 | `github:foundry-rs/forge-std#v1.17.0` (npm'deki `forge-std` 1.1.2'de kaldı) |

Depo kökünde bir kez kur, sonra derle:

```bash
pnpm install          # kökte; contracts/node_modules'u da doldurur
cd contracts && forge build
```

`remappings.txt` `node_modules/...` yollarını gösterir; `foundry.toml`'da `libs = ["node_modules"]`.
forge-std v1.17.0 Foundry 1.7 ile doğrulandı. Sürüm yükseltirken `package.json`'daki sürümü değiştir,
`pnpm install` çalıştır ve `forge test` ile doğrula.

## Komutlar

```bash
forge build
forge test -vv
forge script script/Deploy.s.sol --rpc-url $FUJI_RPC --broadcast
```

## Yapı

- `src/interfaces/IFlightPlan.sol` — dondurulmuş arayüz (§8.1, A0.2)
- `src/FlightPlan.sol` — uygulama (A1, Pyth'siz; bant açıksa kod 6)
- `test/` — F-1…F-15 (§18)
- `script/` — Deploy.s.sol (A2)
