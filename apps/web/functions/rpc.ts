// Aynı kökenli JSON-RPC aracısı: Avalanche Fuji C-Chain (43113).
// Herkese açık RPC'ler hız sınırına takılabildiği için okumalar sırayla birkaç anahtarsız sağlayıcıdan geçer.

const UPSTREAMS = [
  "https://api.avax-test.network/ext/bc/C/rpc",
  "https://avalanche-fuji-c-chain-rpc.publicnode.com",
  "https://43113.rpc.thirdweb.com",
];

const ALLOWED = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getLogs", "eth_getCode", "eth_getBalance",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_estimateGas",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getTransactionCount", "net_version",
]);

type Rpc = { method?: string };
type RpcReply = { error?: { code?: number; message?: string } };

/** True when an upstream answered but refused (rate limit, plan limit, range limit). */
function refused(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as RpcReply | RpcReply[];
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    return replies.some((r) => {
      const msg = r.error?.message?.toLowerCase() ?? "";
      return r.error !== undefined && (r.error.code === -32005 || msg.includes("limit") || msg.includes("not supported") || msg.includes("exceeded"));
    });
  } catch {
    return true;
  }
}

export const onRequestPost = async ({ request }: { request: Request }): Promise<Response> => {
  const body = await request.text();
  if (body.length > 200_000) return new Response("payload too large", { status: 413 });
  let parsed: Rpc | Rpc[];
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length > 50 || calls.some((c) => !c.method || !ALLOWED.has(c.method))) {
    return new Response("method not allowed", { status: 403 });
  }

  let lastText = "upstream unavailable";
  let lastStatus = 502;
  for (const url of UPSTREAMS) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await res.text();
      if (res.ok && !refused(text)) {
        return new Response(text, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "x-upstream": new URL(url).host } });
      }
      lastText = text;
      lastStatus = res.ok ? 429 : res.status;
    } catch {
      /* network error: try the next provider */
    }
  }
  return new Response(lastText, { status: lastStatus, headers: { "content-type": "application/json" } });
};
