'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { DASHBOARD_HELP, type HelpKey } from './dashboardHelp';

// Help tips are off until someone flips the "Show help" switch, so hovering
// around the dashboard stays quiet. The choice is remembered per browser.
const STORAGE_KEY = 'pf-dashboard-show-help';
const HelpModeContext = createContext<{ on: boolean; setOn: (on: boolean) => void }>({ on: false, setOn: () => {} });

export function HelpTipProvider({ children }: { children: ReactNode }) {
  // Only mounted after the user loads client-side, so reading storage here
  // can't cause a hydration mismatch.
  const [on, setOnState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  function setOn(next: boolean) {
    setOnState(next);
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
  }
  return (
    <HelpModeContext.Provider value={{ on, setOn }}>
      <Tooltip.Provider>{children}</Tooltip.Provider>
    </HelpModeContext.Provider>
  );
}

export function HelpToggle() {
  const { on, setOn } = useContext(HelpModeContext);
  return (
    <button
      onClick={() => setOn(!on)}
      aria-pressed={on}
      className={`ml-auto self-center flex items-center gap-1.5 px-3 py-1 text-xs rounded-full font-medium border transition-colors ${
        on ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
      }`}
    >
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${on ? 'bg-white text-slate-800' : 'bg-slate-200 text-slate-600'}`}>?</span>
      {on ? 'Help on' : 'Show help'}
    </button>
  );
}

// With help on, hover any wrapped element to see what it is and where its
// numbers come from. Text lives in dashboardHelp.ts.
export function HelpTip({
  id, children, className,
}: {
  id: HelpKey;
  children: ReactNode;
  className?: string;
}) {
  const { on } = useContext(HelpModeContext);
  if (!on) return className ? <span className={className}>{children}</span> : <>{children}</>;

  const help = DASHBOARD_HELP[id];
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={150}
        render={<span className={`cursor-help underline decoration-dotted decoration-slate-400 underline-offset-2 ${className ?? ''}`} />}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8} className="z-50">
          <Tooltip.Popup className="max-w-xs rounded-md bg-slate-900 px-3 py-2 text-xs leading-relaxed text-slate-100 shadow-lg">
            <p>{help.what}</p>
            <p className="mt-1.5 text-slate-400">
              <span className="font-semibold text-slate-300">Source:</span> {help.source}
            </p>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
