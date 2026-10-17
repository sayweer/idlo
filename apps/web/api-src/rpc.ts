// Vercel adaptörü: Cloudflare Pages fonksiyonu functions/rpc.ts'i olduğu gibi çalıştırır.
import { onRequestPost } from "../functions/rpc.js";

export function POST(request: Request): Promise<Response> {
  return onRequestPost({ request });
}
