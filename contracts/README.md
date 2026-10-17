# contracts — Uçuş Planı (Foundry, Fuji)

Tek doğru kaynak: `../docs/SPEC.md` §8.

## Kurulum

Bağımlılıklar git'e girmez (`lib/` yok sayılır). Bir kez kur:

```bash
cd contracts
forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.7.0 vectorized/solady@v0.1.26
```

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
