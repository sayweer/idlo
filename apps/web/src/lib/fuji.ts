import { createPublicClient, defineChain, fallback, http } from "viem";
import { avalancheFuji } from "viem/chains";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { FUJI_CHAIN_ID } from "@pilot/shared";

// Gezgin UI_HANDOFF §2 gereği Snowtrace testnet.
export const fuji = defineChain({
  ...avalancheFuji,
  blockExplorers: { default: { name: "Snowtrace", url: "https://testnet.snowtrace.io" } },
});
if (fuji.id !== FUJI_CHAIN_ID) throw new Error("viem avalancheFuji ile @pilot/shared FUJI_CHAIN_ID aynı değil");

// Okumalar önce aynı kökenli /rpc aracısından (Cloudflare edge, functions/rpc.ts) geçer; doğrudan RPC yedektir
// ve yerel geliştirmede (Pages Function yok) tek yoldur. VITE_FUJI_RPC bir yerel anvil fork'una çevrilebilir.
const opts = { retryCount: 4, retryDelay: 500, batch: { wait: 30 } } as const;
const customRpc = import.meta.env.VITE_FUJI_RPC as string | undefined;
const relay = typeof window !== "undefined" && window.location.hostname !== "localhost" ? [http("/rpc", opts)] : [];
const transport = fallback([
  ...relay,
  ...(customRpc ? [http(customRpc, opts)] : []),
  http("https://api.avax-test.network/ext/bc/C/rpc", opts),
]);

export const publicClient = createPublicClient({ chain: fuji, transport });

// Yalnız enjekte sağlayıcılar (EIP-6963: Core, MetaMask). Başka bağlayıcı paketi eklenmez.
export const wagmiConfig = createConfig({
  chains: [fuji],
  connectors: [injected()],
  transports: { [fuji.id]: transport },
});

export const explorerTx = (hash: string) => `${fuji.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (a: string) => `${fuji.blockExplorers.default.url}/address/${a}`;
