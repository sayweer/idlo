import { useQuery } from "@tanstack/react-query";
import { parseDeployments, type Deployments } from "@pilot/shared";

/**
 * deployments/fuji.json durumu (UI_HANDOFF §3.3). Fail-closed:
 * - "none": dosya yok (Seyit henüz deploy etmedi) → NO_DEPLOYMENT, imza ve zincir okuma kapalı
 * - "invalid": dosya var ama parseDeployments reddetti (yanlış zincir, sıfır adres …) → "Kontrat adresi okunamadı"
 * - "ready": adresler geçerli
 */
export type DeploymentState =
  | { status: "loading" }
  | { status: "none" } // NO_DEPLOYMENT
  | { status: "invalid"; message: string }
  | { status: "ready"; deployments: Deployments };

const SOURCE = import.meta.env.VITE_DEPLOYMENTS_URL ?? "/deployments/fuji.json";

/** Dosyayı okur; SPA yedeği (404 yerine index.html 200) "yok" sayılır. Ağ hatası "invalid" olur, "yok" değil. */
export async function loadDeployments(fetchImpl: typeof fetch = fetch): Promise<DeploymentState> {
  let res: Response;
  try {
    res = await fetchImpl(SOURCE, { cache: "no-store" });
  } catch (e) {
    return { status: "invalid", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 404) return { status: "none" };
  if (!res.ok) return { status: "invalid", message: `HTTP ${res.status}` };
  const text = await res.text();
  const looksLikeHtml = (res.headers.get("content-type") ?? "").includes("text/html") || text.trimStart().startsWith("<");
  if (looksLikeHtml || text.trim() === "") return { status: "none" };
  try {
    return { status: "ready", deployments: parseDeployments(text) };
  } catch (e) {
    return { status: "invalid", message: e instanceof Error ? e.message : String(e) };
  }
}

export function useDeployments(): DeploymentState {
  const q = useQuery({ queryKey: ["deployments"], queryFn: () => loadDeployments(), staleTime: 60_000, retry: false });
  if (q.isPending) return { status: "loading" };
  if (q.isError) return { status: "invalid", message: q.error instanceof Error ? q.error.message : String(q.error) };
  return q.data;
}

/** İmza ve zincir okuma yalnız "ready" iken açılır. */
export const deploymentsOf = (s: DeploymentState): Deployments | null => (s.status === "ready" ? s.deployments : null);
