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

  // ── Inventory ──────────────────────────────────────────────────────────────
  'inv.view.order': {
    what:   'Which Katana components to order, and by when, so they arrive before the Design schedule needs them.',
    source: 'Katana stock and open purchase orders, set against the Design schedule built from PF API orders.',
  },
  'inv.view.supplier': {
    what:   'A sheet per supplier showing when each of their items has to arrive, week by week or month by month, to print or download and send them.',
    source: 'The What to order plan (Katana stock, open purchase orders and recipes against the Design schedule), including manager edits.',
  },
  'inv.view.schedule': {
    what:   'Frames, backing and glass each upcoming week needs, order by order, in the order Design will work them.',
    source: 'PF API orders in Ready to Frame (plus late Preservation), their Shopify add-ons, and Design capacity from the Weekly Schedule.',
  },
  'inv.csv': {
    what:   'Downloads the order-by-order list below as a spreadsheet.',
    source: 'The same data shown on this view.',
  },
  'inv.schedule.title': {
    what:   'How many of each frame, backing and glass Design will use each week if it works orders oldest-intake first.',
    source: 'PF API orders + Shopify Backing/Glass add-ons, scheduled against Design capacity saved in Supabase.',
  },
  'inv.plan.title': {
    what:   'Each scheduled order broken into its Katana recipe, taken out of stock week by week. The number is what you still need to order.',
    source: 'Katana MRP recipes, stock and open purchase orders. Manager edits are saved in Supabase.',
  },
  'inv.orderNow': {
    what:   'Items whose order-by date is this week or already passed, given each supplier\'s lead time.',
    source: 'Katana stock vs. the Design schedule, with supplier lead times set in the dashboard code.',
  },
  'inv.createPos': {
    what:   'Groups what needs ordering by supplier so you can create purchase orders.',
    source: 'Katana (purchase orders are created there).',
  },
  'inv.col.intake':       { what: 'The week the order\'s bouquet came in. Design works oldest intake first.', source: 'PF API order history.' },
  'inv.col.total':        { what: 'Total needed across all the weeks shown.', source: 'Sum of the weeks in this row.' },
  'inv.col.supplier':     { what: 'Who we buy this component from.', source: 'Katana MRP supplier on the item.' },
  'inv.col.toOrder':      { what: 'How many more to order to cover every week shown.', source: 'Needed minus Katana in-stock and on-order.' },
  'inv.col.neededWk':     { what: 'Amount of this component the week\'s scheduled orders use.', source: 'Katana recipes × the Design schedule.' },
  'inv.col.neededThru':   { what: 'Total this component is needed through the end of the schedule.', source: 'Katana recipes × the Design schedule.' },
  'inv.col.inStock':      { what: 'On hand right now at this location (negative counts as 0).', source: 'Katana MRP stock.' },
  'inv.col.onOrder':      { what: 'Already on an open purchase order and not received yet.', source: 'Katana MRP purchase orders.' },
  'inv.col.orderBy':      { what: 'Latest week to place the order so it arrives in time, using the supplier\'s lead time.', source: 'Calculated from the schedule and lead times.' },
  'inv.col.usePerWk':     { what: 'Average used per week in the current schedule.', source: 'Katana recipes × the Design schedule.' },
  'inv.col.coveredUntil': { what: 'Week stock plus on-order runs out at the current pace.', source: 'Katana stock ÷ weekly use.' },
  'inv.col.poQty':        { what: 'Quantity that will go on the purchase order, in the supplier\'s unit.', source: 'Calculated shortfall; you can edit it before creating the PO.' },

  // ── Scorecards ─────────────────────────────────────────────────────────────
  'sc.title': {
    what:   'Monthly cost per order (CPO), ratios and production, with goals for next month.',
    source: 'Supabase: Rippling payroll uploads (weekly_labor_cost), weekly team actuals, and saved goals (scorecard_goals).',
  },
  'sc.cpoByDept':  { what: 'Labor cost ÷ production for each department, by month. Green = at/under goal, amber = between goal and minimum, red = over minimum.', source: 'Rippling payroll uploads + weekly production actuals in Supabase.' },
  'sc.blended':    { what: 'Utah and Georgia CPO and ratios combined into one company number. Excludes Resin.', source: 'Rippling payroll uploads + weekly actuals in Supabase.' },
  'sc.production': { what: 'Units each department finished per month: frames, bouquets, orders shipped, resin pieces.', source: 'Weekly actuals in Supabase (team_member_week_actuals).' },
  'sc.ratios':     { what: 'Each team member\'s hours ÷ units completed by month. Lower is better; compared to role targets.', source: 'Weekly hours and production in Supabase.' },
  'sc.whatIf':     { what: 'Scratch pad: change ratios for a group and see how CPO would move. Nothing here is saved.', source: 'Starts from this page\'s numbers.' },
  'sc.targets':    { what: 'Hours-per-unit goal for each role level (Specialist, Senior, Master).', source: 'Set in the dashboard code (ratioTargets).' },
  'sc.l3':         { what: 'Average of the last 3 complete months.', source: 'The months in this row.' },
  'sc.ytd':        { what: 'Average of every month so far this year.', source: 'The months in this row.' },
  'sc.goal':       { what: 'The target for next month. Click a cell to edit.', source: 'Saved goals in Supabase (scorecard_goals).' },
  'sc.minimum':    { what: 'The worst acceptable number for next month. Click a cell to edit.', source: 'Saved goals in Supabase (scorecard_goals).' },

  // ── All KPIs ───────────────────────────────────────────────────────────────
  'kpi.title':     { what: 'Ratio (hours per unit) and CPO (labor cost per unit) for every department and location.', source: 'Weekly actuals and Rippling payroll uploads in Supabase, via /api/kpis. Recalculated on every load.' },
  'kpi.location':  { what: 'Which location\'s numbers to show. Combined adds both.', source: '—' },
  'kpi.metric':    { what: 'Ratio = hours ÷ units (managers excluded). CPO = labor cost ÷ units.', source: 'Weekly hours/production and payroll in Supabase.' },
  'kpi.time':      { what: 'The period each number covers. "Est." months are projected from the saved schedules, not actuals.', source: 'Actuals for past periods; Scheduling rosters for estimates.' },
  'kpi.compare':   { what: 'What the small delta under each cell compares against: each person\'s own ratio (Estimated), their role target (Expected), or the stricter of the two (Goal).', source: 'The saved schedule for that period.' },
  'kpi.gm':        { what: 'Whether general manager salaries are added into CPO.', source: 'Manager salaries set in the dashboard code.' },
  'kpi.bonus':     { what: 'Whether monthly performance bonuses are added into CPO. Bonus data lags about 3–4 weeks.', source: 'Monthly bonus upload from Rippling.' },
  'kpi.metricCol': { what: 'The measure in each row.', source: '—' },
  'kpi.period':    { what: 'The week, month or quarter each row covers.', source: '—' },

  // ── Growth & Distribution ──────────────────────────────────────────────────
  'gr.companyTotal': { what: 'Bouquets expected vs. received each week, company-wide and split between Utah and Georgia.', source: 'Weekly received actuals in Supabase; forecast = same week last year × growth multiplier.' },
  'gr.lastYear':     { what: 'Bouquets received the same week last year (52 weeks back).', source: 'Weekly received actuals in Supabase.' },
  'gr.estMult':      { what: 'Growth multiplier applied to last year to get this year\'s estimate. Rolling average unless someone typed one in.', source: 'Calculated from recent weeks, or a saved weekly snapshot / manual override.' },
  'gr.estReceived':  { what: 'Forecast bouquets for the week: last year × multiplier.', source: 'Calculated.' },
  'gr.actReceived':  { what: 'Bouquets that actually came in that week.', source: 'Weekly received actuals in Supabase.' },
  'gr.variance':     { what: 'Actual minus estimated. Positive = more came in than forecast.', source: 'Calculated.' },
  'gr.actMult':      { what: 'Actual received ÷ last year, i.e. the growth that really happened.', source: 'Calculated.' },
  'gr.utPct':        { what: 'Share of the forecast expected to go to Utah, based on state routing and seasonality.', source: 'Shopify shipping-state history + State Routing below.' },
  'gr.gaPct':        { what: 'Share of the forecast expected to go to Georgia.', source: '100% minus the Utah share.' },
  'gr.actualDist':   { what: 'How received bouquets actually split between locations.', source: 'Weekly received actuals in Supabase.' },
  'gr.routing':      { what: 'Planning record of which location each state ships to. Editing here does not change live order routing.', source: 'Supabase (state_location_routing).' },
  'gr.plan':         { what: 'Simulate moving a state to the other location from a start date and see the forecast change.', source: 'Shopify state-level sales history + saved planned moves in Supabase.' },
  'gr.shipping':     { what: 'Estimated shipping and CPO gain or loss per order if each state moved locations.', source: 'Formula-based FedEx estimate (not a live rate), Shopify order volume by state, and last 3 months\' CPO.' },
  'gr.colOrders':    { what: 'Orders shipped to this state in the period.', source: 'Shopify order shipping states (shopify_order_state_facts).' },
  'gr.colShipUt':    { what: 'Estimated cost to ship one order to this state from Utah.', source: 'Formula estimate (shippingCost.ts).' },
  'gr.colShipGa':    { what: 'Estimated cost to ship one order to this state from Georgia.', source: 'Formula estimate (shippingCost.ts).' },
  'gr.colNetUt':     { what: 'Shipping difference plus the CPO gap if this state moved to Utah. Green = saves money.', source: 'Shipping estimate + 3-month blended CPO.' },
  'gr.colNetGa':     { what: 'Shipping difference plus the CPO gap if this state moved to Georgia. Green = saves money.', source: 'Shipping estimate + 3-month blended CPO.' },

  // ── Labor Cost ─────────────────────────────────────────────────────────────
  'lab.forecast':      { what: 'Projected labor cost for upcoming months by department.', source: 'Saved Scheduling rosters and hours × each person\'s pay rate; Preservation is staffed to expected bouquets.' },
  'lab.history':       { what: 'Past months: what the schedule planned vs. what payroll actually paid.', source: 'Rippling payroll uploads (weekly_labor_cost) + salaried managers, vs. saved schedules.' },
  'lab.gm':            { what: 'Adds general manager salaries into the totals.', source: 'Manager salaries set in the dashboard code.' },
  'lab.forecastTile':  { what: 'Projected labor cost for the period shown.', source: 'Scheduling rosters × pay rates.' },
  'lab.paid':          { what: 'Total payroll actually paid for scheduled departments over the range.', source: 'Rippling payroll uploads.' },
  'lab.planned':       { what: 'What the saved schedule said those same weeks would cost.', source: 'Saved schedules × today\'s pay rates.' },
  'lab.diff':          { what: 'Actually paid minus planned.', source: 'Calculated.' },
  'lab.worst':         { what: 'The department that went the most over its planned cost.', source: 'Calculated.' },
  'lab.presRange':     { what: 'Range of Preservation cost: lowest if hours flex to bouquets, highest if everyone works their minimum.', source: 'Expected bouquets + Preservation roster and pay.' },

  // ── Team Access ────────────────────────────────────────────────────────────
  'team.title':        { what: 'Everyone who can sign in to this dashboard.', source: 'Clerk accounts + user profiles in Supabase.' },
  'team.invite':       { what: 'Sends a sign-in invite and sets the person\'s role, location and department.', source: 'Creates a Clerk invitation and Supabase profile.' },
  'team.role':         { what: 'Controls what they can see: admins see everything, managers see their department, users see only their own dashboard.', source: 'Supabase user profile.' },
  'team.location':     { what: 'The location they work at; limits which schedules they can edit.', source: 'Supabase user profile.' },
  'team.manager':      { what: 'Who this person reports to.', source: 'Supabase user profile.' },
  'team.scheduleName': { what: 'Their name as it appears in Scheduling. Must match exactly to link their hours and production.', source: 'Supabase user profile.' },

  // ── Scheduling ─────────────────────────────────────────────────────────────
  'sched.dept.design':       { what: 'Design team schedules, queue, actuals and turnaround.', source: 'Schedules/actuals saved in Supabase; queue and production from the PF API.' },
  'sched.dept.preservation': { what: 'Preservation team schedules, staffing vs. incoming bouquets, and actuals.', source: 'Schedules/actuals saved in Supabase; bouquets received and checks from the PF API.' },
  'sched.dept.fulfillment':  { what: 'Fulfillment team schedules, queue and shipping turnaround.', source: 'Schedules/actuals saved in Supabase; queue from the PF API.' },
  'sched.dept.master':       { what: 'Everyone at a location by day, across departments, with days off and availability.', source: 'Rosters, schedules and time off saved in Supabase.' },
  'sched.dept.payroll':      { what: 'Upload Rippling payroll and hours reports that feed CPO everywhere.', source: 'Rippling report files you upload; stored in Supabase.' },
  'sched.dept.resin':        { what: 'Resin team schedule, queue and turnaround.', source: 'Resin orders synced from Shopify into Supabase; schedules saved in Supabase.' },
  'sched.dept.bloomstock':   { what: 'Handprint/paw print/footprint frames and recreations: schedule, open orders and deadlines.', source: 'Live Shopify orders for those products; hours from Rippling uploads.' },
  'sched.tab.thisweek':      { what: 'This week day by day: who\'s scheduled, planned vs. actual output, and month-to-date ratio and CPO.', source: 'Saved schedules + PF API completed production + KPI actuals.' },
  'sched.tab.schedule':      { what: 'Hours each person is scheduled each week going forward. Edits save automatically.', source: 'Schedules and rosters saved in Supabase.' },
  'sched.tab.queue':         { what: 'Every intake week, and how many weeks until it gets done at scheduled capacity.', source: 'PF API queue counts, forecast bouquets, and scheduled hours.' },
  'sched.tab.monthly':       { what: 'Hours, frames, ratio and CPO rolled up by month.', source: 'Weekly actuals + Rippling payroll in Supabase.' },
  'sched.tab.historicals':   { what: 'Week-by-week actual hours and production per person. Editable.', source: 'Weekly actuals in Supabase; synced counts from the PF API.' },
  'sched.kpi':               { what: 'Month-to-date pace against goal. Green = at/under goal, yellow = between goal and expected, red = worse than expected.', source: 'Weekly actuals + Rippling payroll via /api/kpis.' },
  'sched.staffingCheck':     { what: 'Whether each week\'s scheduled Preservation capacity covers the bouquets estimated to arrive that week.', source: 'Scheduled hours × ratios vs. the bouquet forecast (Growth & Distribution).' },
  'sched.hoursPerMember':    { what: 'Scheduled hours per person per week, and the output those hours should produce.', source: 'Schedules and rosters saved in Supabase.' },
  'sched.hiring':            { what: 'Try out hypothetical new hires and see how they change turnaround. Nothing is hired here.', source: 'Your inputs, saved with the schedule settings.' },
  'sched.queueTurnaround':   { what: 'Every intake week, oldest first, with the estimated weeks until it ships. Target is shown in the description.', source: 'PF API queue counts + scheduled capacity at each stage.' },
  'sched.masterSchedule':    { what: 'Everyone\'s week by day, coloured by department. Red ⚠ = over-scheduled.', source: 'Rosters, schedules, unavailability and time off saved in Supabase.' },
  'sched.monthlySummary':    { what: 'Each week attributed to the month of its Monday. Ratio = total hours ÷ total units.', source: 'Weekly actuals in Supabase.' },
  'sched.perDesigner':       { what: 'Each designer\'s hours, frames and ratio by month.', source: 'Weekly actuals in Supabase.' },
  'sched.rippling':          { what: 'Upload Rippling\'s payroll report every two weeks so CPO uses real pay. Pay is never shown to team members.', source: 'Rippling report you upload; stored in Supabase.' },
  'sched.historicals':       { what: 'Week-by-week actuals for this department and location. Edit any cell.', source: 'Weekly actuals in Supabase; synced counts from the PF API.' },
  'sched.weekActuals':       { what: 'Enter frames completed and hours worked for the selected week.', source: 'Saved to Supabase and shared with everyone.' },
  'sched.allWeeks':          { what: 'Every week saved so far.', source: 'Weekly actuals in Supabase.' },
  'sched.weeksUntilDesigned':  { what: 'Estimated weeks from today until this intake week is designed.', source: 'Design queue (PF API) ÷ scheduled Design capacity.' },
  'sched.weeksUntilFulfilled': { what: 'Estimated weeks from today until this intake week ships.', source: 'Design estimate chained into the Fulfillment queue and capacity.' },
  'sched.bouquetsEst':       { what: 'Bouquets forecast to arrive that week.', source: 'Growth & Distribution forecast (last year × growth, split by location).' },
  'sched.disapproval':       { what: 'Disapprovals ÷ approvals. Green ≤15%.', source: 'PF API order status history.' },
  'sched.adjustOrder':       { what: 'Manually add or remove an order from someone\'s synced production.', source: 'Saved as an adjustment in Supabase.' },
  'resin.tab.schedule':      { what: 'Hours each Resin team member is scheduled, a full year ahead.', source: 'Resin schedule saved in Supabase.' },
  'bloom.tab.orders':        { what: 'Open bloom stock orders to sort and work. The badge counts new orders not sorted yet.', source: 'Live Shopify orders for these products.' },
  'resin.title':             { what: 'Resin team schedule, actuals and queue.', source: 'Resin orders synced from Shopify into Supabase; schedules saved in Supabase.' },
  'resin.turnaround':        { what: 'Weeks from event-date intake until each week\'s resin orders are done. Intake is the event date plus a few days.', source: 'Shopify event-date tags on resin orders + scheduled capacity.' },
  'resin.queue':             { what: 'Every open resin unit, page by page.', source: 'Resin queue synced from Shopify into Supabase.' },
  'bloom.title':             { what: 'Handprint, paw print, footprint frames and bloom recreations. Worked oldest order first.', source: 'Live Shopify orders for these products.' },
  'bloom.openOrders':        { what: 'New, Ready to Design and Influencer orders waiting to be made.', source: 'Live Shopify orders.' },
  'bloom.whatIf':            { what: 'Add extra weekly orders (e.g. a launch) to see the effect. Toggle off to compare.', source: 'Your inputs.' },
  'bloom.deadline':          { what: 'Whether everything ordered before a cutoff can be finished by a due date.', source: 'Open orders + scheduled hours ÷ ratios.' },
  'bloom.queue':             { what: 'Open orders then forecast weeks, with turnaround from order placed to finished.', source: 'Shopify orders; forecast = same week last year × growth.' },
  'bloom.hours':             { what: 'Hours and completed orders per person per week.', source: 'Order numbers you log + hours from Rippling\'s Recreation department.' },
} satisfies Record<string, HelpEntry>;

export type HelpKey = keyof typeof DASHBOARD_HELP;

export function statusHelpKey(status: string): HelpKey | null {
  const key = `status.${status}`;
  return key in DASHBOARD_HELP ? (key as HelpKey) : null;
}
