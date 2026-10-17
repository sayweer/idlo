/** The flight plan mark: a folded paper plane on a pinned card. Ink on paper, a brass fold (never red: red means a refusal). */
export function Logo({ size = 28, dark = false, plate = false }: { size?: number; dark?: boolean; plate?: boolean }) {
  const ink = dark ? "#f3ecdf" : "#1d1a16";
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {plate && <rect width="64" height="64" rx="14" fill={dark ? "#1d1a16" : "#f3ecdf"} />}
      <path d="M10 30 54 10 40 54 29 37z" fill="none" stroke={ink} strokeWidth="6" strokeLinejoin="round" />
      <path d="M29 37 54 10 33 42z" fill="#d6a733" />
    </svg>
  );
}
