// Vercel adaptörü: Cloudflare Pages fonksiyonu functions/api/plan/draft.ts'i olduğu gibi çalıştırır.
// Cloudflare'deki `env` yerine Vercel ortam değişkenleri (ANTHROPIC_API_KEY, LLM_MODEL) process.env'den gelir.
import { onRequestGet, onRequestPost } from "../../functions/api/plan/draft.js";

const env = () => process.env as Parameters<typeof onRequestPost>[0]["env"];

export function GET(): Response {
  return onRequestGet({ env: env() });
}

export function POST(request: Request): Promise<Response> {
  return onRequestPost({ request, env: env() });
}
