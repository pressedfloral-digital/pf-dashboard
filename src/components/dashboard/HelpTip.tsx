'use client';

import type { ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { DASHBOARD_HELP, type HelpKey } from './dashboardHelp';

// Hover any wrapped element to see what it is and where its numbers come from.
// Text lives in dashboardHelp.ts so it can be edited in one place.
export function HelpTip({
  id, children, className,
}: {
  id: HelpKey;
  children: ReactNode;
  className?: string;
}) {
  const help = DASHBOARD_HELP[id];
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={350}
        render={<span className={`cursor-help ${className ?? ''}`} />}
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

export const HelpTipProvider = Tooltip.Provider;
