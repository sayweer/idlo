import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError, type Hash } from "viem";
import { useConnection, useSwitchChain, useWriteContract } from "wagmi";
import { explorerTx, fuji, publicClient } from "./fuji";
import { useLang } from "./i18n";

type Toast = { kind: "pending" | "ok" | "error"; text: string; hash?: Hash };
const ToastCtx = createContext<(t: Toast | null) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const { t } = useLang();
  return (
    <ToastCtx.Provider value={setToast}>
      {children}
      {toast && (
        <div className={`toast card no-pin ${toast.kind === "error" ? "" : "kraft"}`} role="status" onClick={() => setToast(null)}>
          <div className="label">{t(toast.kind === "pending" ? "toast.pending" : toast.kind === "ok" ? "toast.ok" : "toast.error")}</div>
          <p className="mono" style={{ marginTop: 6 }}>{toast.text}</p>
          {toast.hash && (
            <a className="mono" href={explorerTx(toast.hash)} target="_blank" rel="noreferrer">{t("toast.view")}</a>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Is the wallet connected to Fuji? Every write button uses this so a wrong chain never fails silently. */
export function useFujiGuard() {
  const { address, chainId, isConnected } = useConnection();
  const { switchChainAsync } = useSwitchChain();
  const onFuji = isConnected && chainId === fuji.id;
  const switchToFuji = useCallback(() => switchChainAsync({ chainId: fuji.id }), [switchChainAsync]);
  return { address, isConnected, onFuji, switchToFuji };
}

/** Human-readable reason from a viem error (custom errors from the contract included: `err.<ErrorName>`). */
export function reason(e: unknown, t: (k: string) => string): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "";
      const key = `err.${name}`;
      const msg = t(key);
      return msg !== key ? msg : name || revert.shortMessage;
    }
    if (e.shortMessage.toLowerCase().includes("user rejected")) return t("err.rejected");
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

type WriteArgs = Parameters<ReturnType<typeof useWriteContract>["writeContractAsync"]>[0];

/**
 * Send a contract write, wait for Fuji to confirm, report through the toast. Returns the receipt, the hash and the
 * send-to-receipt time in ms (UI_HANDOFF §3.5: "gönderimden makbuza"), or null. Signing screens call this only from
 * the confirmation window.
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const toast = useToast();
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const send = useCallback(
    async (label: string, args: WriteArgs) => {
      setBusy(true);
      try {
        toast({ kind: "pending", text: t("toast.confirm", { label }) });
        const hash = await writeContractAsync({ ...args, chainId: fuji.id } as WriteArgs);
        const sentAt = performance.now();
        toast({ kind: "pending", text: t("toast.waiting", { label }), hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
        const finalityMs = Math.round(performance.now() - sentAt);
        if (receipt.status !== "success") throw new Error(t("err.reverted"));
        toast({ kind: "ok", text: t("toast.done", { label }), hash });
        return { receipt, hash, finalityMs };
      } catch (e) {
        toast({ kind: "error", text: `${label}: ${reason(e, t)}` });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [writeContractAsync, toast, t],
  );
  return { send, busy };
}
