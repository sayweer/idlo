#!/usr/bin/env bash
# Vercel'e üretim yayını (apps/web klasöründen çalıştır): bash scripts/deploy-vercel.sh
# Cloudflare fonksiyonları (functions/) api-src/ adaptörleriyle tek dosyaya paketlenip api/ altına yazılır;
# Vercel'in dosya izleyicisi workspace içe aktarmalarını izleyemediği için paketleme şart.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf api && mkdir -p api/plan
for f in rpc agents plan/draft; do
  npx -y esbuild@0.25.10 "api-src/$f.ts" --bundle --platform=node --format=esm --target=node22 --outfile="api/$f.mjs" --log-level=error
done
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod --yes
rm -rf api
