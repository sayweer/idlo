// Vercel adaptörü: Cloudflare Pages fonksiyonu functions/api/agents.ts'i olduğu gibi çalıştırır.
import { onRequestPost } from "../functions/api/agents.js";

export function POST(request: Request): Promise<Response> {
  return onRequestPost({ request });
}
