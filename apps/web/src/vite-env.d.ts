/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FUJI_RPC?: string;
  readonly VITE_DEPLOYMENTS_URL?: string;
  readonly VITE_FEED?: "mock" | "http";
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
