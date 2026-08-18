import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// /api/kpis and /api/scorecard are public at the middleware layer, same as
// /api/cron/(.*), because they accept a SCORECARDS_SYNC_SECRET bearer token
// from the pressedfloral-scorecards monthly sync in addition to a Clerk
// session — that check happens inside each route handler, not here.
const isPublicRoute = createRouteMatcher(['/api/leads', '/sign-in(.*)', '/sign-up(.*)', '/api/webhooks/(.*)', '/api/cron/(.*)' , '/api/admin/sync-shopify-locations', '/api/cron/sync-shopify-tags', '/api/admin/seed-historicals', '/api/kpis', '/api/scorecard']);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) await auth.protect();
});

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'],
};
