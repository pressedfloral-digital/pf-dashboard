// Hover text for the dashboard: what each thing is, and where its data comes from.
// "PF API" is the Pressed Floral production app (pressedfloralapi.azurewebsites.net).

export interface HelpEntry {
  what:   string;
  source: string;
}

const STATUS_COUNTS_SOURCE =
  'PF API order counts by status and location (/OrderProducts/CountsByLocation), loaded when the page opens. Click the number for the order list (PF API weekly reports).';

export const DASHBOARD_HELP = {
  // ── Top-level tabs ─────────────────────────────────────────────────────────
  'tab.dashboard': {
    what:   'Live view of where every order sits in production, by department and location, plus event-date lookups and designer response times.',
    source: 'PF API, Shopify, and the location cache in Supabase.',
  },
  'tab.scheduling': {
    what:   'Weekly staffing schedules, queue sizes, and weekly actuals for each department and location.',
    source: 'Weekly actuals and schedule settings saved in Supabase, live queue counts from the PF API, and event dates from Shopify.',
  },
  'tab.inventory': {
    what:   'Frame and component stock against the orders coming up in the design queue, plus what to reorder from suppliers.',
    source: 'Katana MRP (recipes, stock, purchase orders) matched to Shopify order line items.',
  },
  'tab.scorecards': {
    what:   'Monthly scorecards for managers and departments.',
    source: 'Weekly actuals in Supabase, rolled up by month.',
  },
  'tab.kpis': {
    what:   'Every department KPI side by side against its target, over rolling time windows.',
    source: 'Weekly actuals and labor uploads saved in Supabase; targets are set in the dashboard code.',
  },
  'tab.growth': {
    what:   'Sales by state, which location each state routes to, and the forecast for planned routing moves.',
    source: 'Shopify sales by state, plus routing rules and forecast snapshots saved in Supabase.',
  },
  'tab.labor': {
    what:   'Labor cost forecast and actuals per order (admins only).',
    source: 'Rippling payroll uploads and weekly actuals saved in Supabase.',
  },
  'tab.team': {
    what:   'Who can sign in to the dashboard, their role, department, and location.',
    source: 'Clerk sign-in accounts plus user profiles in Supabase.',
  },

  // ── Department Dashboard ───────────────────────────────────────────────────
  'dash.location': {
    what:   'Picks which location the Pipeline and Response Times sections show. "All" adds Utah and Georgia together.',
    source: 'Locations found in the PF API pipeline counts.',
  },
  'pipeline.title': {
    what:   'How many orders are in each production status right now, grouped by department.',
    source: STATUS_COUNTS_SOURCE,
  },
  'pipeline.inQueue': {
    what:   'Orders placed whose bouquet has not arrived yet (status "Order Received"). Not counted in any department.',
    source: 'PF API order counts (/OrderProducts/CountsByLocation).',
  },
  'pipeline.shopifyCheck': {
    what:   'Checks every Ready to Frame / Ready to Seal order against Shopify and flags ones that are cancelled, refunded, already fulfilled, store pickup, $0, or over 12 months old.',
    source: 'PF API weekly reports for the orders, then a Shopify lookup for each one. Runs only when clicked.',
  },
  'pipeline.export': {
    what:   'Downloads a CSV of all orders in Ready to Frame and Ready to Seal.',
    source: 'PF API weekly reports (/OrderProducts/WeeklyReport).',
  },
  'pipeline.dept.Preservation': {
    what:   'Orders with Preservation: bouquet received through almost ready to frame. The big number is the total of the rows below.',
    source: STATUS_COUNTS_SOURCE,
  },
  'pipeline.dept.Design': {
    what:   'Orders with Design: ready to frame, waiting on the client, disapproved, or approved. The big number is the total of the rows below.',
    source: STATUS_COUNTS_SOURCE,
  },
  'pipeline.dept.Fulfillment': {
    what:   'Orders with Fulfillment: ready to seal through preparing to ship. The big number is the total of the rows below.',
    source: STATUS_COUNTS_SOURCE,
  },
  'pipeline.onHold': {
    what:   'Open orders tagged "hold" in Shopify. Click to see which ones.',
    source: 'Shopify open orders with the "hold" tag.',
  },

  // Status rows (shared by Pipeline and Sorted by Location)
  'status.bouquetReceived':      { what: 'Bouquet has arrived and is waiting to start preservation.', source: STATUS_COUNTS_SOURCE },
  'status.checkedOn':            { what: 'Bouquet has had its first check-in by Preservation.', source: STATUS_COUNTS_SOURCE },
  'status.progress':             { what: 'Flowers are actively being pressed / preserved.', source: STATUS_COUNTS_SOURCE },
  'status.almostReadyToFrame':   { what: 'Preservation is nearly done; the order will move to Design soon.', source: STATUS_COUNTS_SOURCE },
  'status.readyToFrame':         { what: 'Flowers are ready and waiting for a designer to build the frame.', source: STATUS_COUNTS_SOURCE },
  'status.frameCompleted':       { what: 'Design was sent to the client and we are waiting for them to respond.', source: STATUS_COUNTS_SOURCE },
  'status.disapproved':          { what: 'Client asked for changes to the design.', source: STATUS_COUNTS_SOURCE },
  'status.approved':             { what: 'Client approved the design; it is headed to Fulfillment.', source: STATUS_COUNTS_SOURCE },
  'status.readyToSeal':          { what: 'Approved frame waiting to be sealed.', source: STATUS_COUNTS_SOURCE },
  'status.glued':                { what: 'Frame has been glued / sealed and is curing.', source: STATUS_COUNTS_SOURCE },
  'status.readyToPackage':       { what: 'Finished frame waiting to be packaged.', source: STATUS_COUNTS_SOURCE },
  'status.readyToFulfill':       { what: 'Packaged and waiting for a shipping label.', source: STATUS_COUNTS_SOURCE },
  'status.preparingToBeShipped': { what: 'Label made; waiting for carrier pickup.', source: STATUS_COUNTS_SOURCE },

  'sorted.title': {
    what:   'Same pipeline split into Utah and Georgia side by side, including orders that have no location in the PF app (matched to a location by staff or bouquet uploader).',
    source: 'PF API counts plus the order-location cache in Supabase (uuid_location_cache).',
  },
  'sorted.location': {
    what:   'Total orders in production at this location.',
    source: 'PF API counts plus resolved unassigned orders from the Supabase location cache.',
  },
  'sorted.unsorted': {
    what:   'Orders we still could not place at a location. Orders numbered below #22000 are assumed cancelled (from before location tracking).',
    source: 'Supabase location cache (uuid_location_cache).',
  },
  'sorted.resolve': {
    what:   'Tries to give unassigned orders a location using the staff member working on them.',
    source: 'Supabase staff → location list (staff_locations), applied to the location cache.',
  },
  'sorted.sync': {
    what:   'Rescans the PF app and rebuilds the order-location cache. Slow; also runs on a schedule.',
    source: 'PF API weekly reports and order search, written to Supabase.',
  },
  'sorted.refresh': {
    what:   'Reloads the counts on this section without rescanning.',
    source: 'PF API counts + Supabase location cache.',
  },

  'event.title': {
    what:   'Finds orders whose wedding / event date falls in the chosen range, so you can plan around upcoming events.',
    source: 'Shopify orders from the last 2 months, matched on their event-date tag.',
  },

  'response.title': {
    what:   'How long designers take to reply after a client sends a message. Green is under 1 hour, amber under 4 hours, red over 4 hours.',
    source: 'PF API order conversations (/OrderConversation/Messages) for orders in the date range, grouped by assigned designer. Runs only when you click Calculate.',
  },
  'response.average': {
    what:   'Average reply time across every client message in the range, all designers combined.',
    source: 'PF API order conversations.',
  },
} satisfies Record<string, HelpEntry>;

export type HelpKey = keyof typeof DASHBOARD_HELP;

export function statusHelpKey(status: string): HelpKey | null {
  const key = `status.${status}`;
  return key in DASHBOARD_HELP ? (key as HelpKey) : null;
}
