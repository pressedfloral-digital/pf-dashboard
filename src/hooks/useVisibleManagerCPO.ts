import { useEffect, useState, useCallback } from "react";

interface VisibleManagersState {
  all: boolean;
  names: Set<string>;
}

// Fails closed: until the permission check returns, no manager's CPO is
// shown — pay-privacy data should default to hidden, not visible.
export function useVisibleManagerCPO() {
  const [state, setState] = useState<VisibleManagersState>({ all: false, names: new Set() });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/visible-managers")
      .then(r => (r.ok ? r.json() : { all: false, names: [] }))
      .then((d: { all?: boolean; names?: string[] }) => {
        if (cancelled) return;
        setState({ all: !!d.all, names: new Set(d.names ?? []) });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canSeeManagerCPO = useCallback(
    (name: string) => state.all || state.names.has(name),
    [state]
  );

  return { canSeeManagerCPO };
}
