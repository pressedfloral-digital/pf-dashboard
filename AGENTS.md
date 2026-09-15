# Pressed Floral repository context

This repository belongs to the `pressedfloral-digital` GitHub organization. The legacy
`pf-sarah/pf-dashboard` remote redirects to the canonical organization. All repositories
below are first-party Pressed Floral code unless explicitly noted; agents may inspect and
coordinate changes across them rather than treating their services as unowned vendors.

## Important ownership boundaries

- `pressed-floral-api-master` is the first-party core backend. We own it. It is the .NET 8
  API used by the mobile/staff apps, Support Assistant, and this dashboard. When an API
  behavior is unclear, inspect that repository and coordinate contract changes there.
- `pf-dashboard` (this repository) is the current department operations dashboard.
  `pf-platform` is a separate ground-up data-platform/dashboard rebuild; do not assume a
  change in one exists in the other.
- `pf-platform` owns its shared Supabase schema and most ingestion. `pf-experience-metrics`
  is primarily a presentation surface over that same store; schema and shared connector
  changes belong upstream in `pf-platform`.
- `pressed-floral-app-master` is the established Expo app. `pf-staff-pwa` is the planned
  staff-side successor, after which the Expo app is intended to remain client-facing.

## Organization repository map

All repositories currently use `main` as their default branch.

| Repository | Kind / stack | High-level responsibility |
| --- | --- | --- |
| `Support-Assistant` | TypeScript monorepo; React/Vite, Express, PostgreSQL | Customer-support operations workspace integrating Re:amaze, Shopify, ShipHero, and the internal PF API. Includes Frames/Team production views and AI-assisted ticket triage/replies. |
| `pf-dashboard` | Next.js, React, Clerk, Supabase | Current department dashboard for production pipeline, scheduling, historicals, scorecards, payroll/KPIs, and team access. Reads the internal PF API and stores dashboard-specific operational data in Supabase. |
| `pressed-floral-api-master` | C# / ASP.NET Core .NET 8, PostgreSQL | **Owned core backend and operational system of record.** Provides order, order-product, user, upload, frame workflow, notification, Shopify, and realtime/SignalR APIs used by multiple frontends. |
| `pf-experience-metrics` | TypeScript/Next.js data surface | Experience and marketing metrics presentation layer forked from `pf-platform`. Reads the shared platform database; owns only its Shopify storefront-sessions ingestion. |
| `mainsite-pressed-floral` | Shopify Liquid theme | Production storefront theme for `pressedfloral.com`, including sections, snippets, customer templates, assets, and storefront presentation. |
| `pressedfloral-scorecards` | Next.js, Supabase | Employee/manager scorecard application for goals, actuals, Rippling employee imports, and monthly bonus scorecard submissions. |
| `pressed-floral-app-master` | Expo / React Native / TypeScript | Established cross-platform Pressed Floral mobile/web app. Contains customer and legacy staff workflows and consumes `pressed-floral-api-master`. |
| `pf-platform` | TypeScript monorepo; Supabase/Postgres, Next.js | Ground-up data platform: canonical analytics schema, PF/Shopify/Meta ingestion, tested metric calculations, data-quality checks, and a newer dashboard surface. |
| `pf-layer-manifest-admin` | Shopify embedded app; React Router, Postgres | Staff admin for Pressed Frame visual layer assets. Syncs Shopify Files, manages layer metadata, validates coverage, and publishes the storefront layer manifest. |
| `pf-sale-campaigns` | Shopify embedded/theme app; React Router, Postgres | Countdown-timer and guarded sale-pricing manager. Publishes targeted timers and performs auditable, reversible Shopify variant price changes. |
| `pickup-site-dashboard` | React/Vite, Supabase | Admin and partner portal for pickup-site operations: sites, orders, inventory, billing/payouts, user invitations, and site-specific views. |
| `shipping-label-generation` | Node/Express, PostgreSQL | Shipping-label automation and portals. Receives Shopify paid-order webhooks, routes Utah/Georgia shipments, creates FedEx labels, and emails customers through SendGrid. |
| `pf-staff-pwa` | React/Vite PWA, TypeScript | New internal staff PWA intended to replace the staff half of the Expo app. The shell and migration foundation exist; verify current feature status before relying on it. |
| `pf-chat-agent` | Shopify app; React Router, MCP, Claude | Customer-facing storefront AI chat widget for product discovery, policy help, cart/checkout actions, and order/return assistance through Shopify tools. |
| `claude-skills` | Agent instructions / Python utilities | Shared Pressed Floral brand, design, CRO, client-response, ad-scoring, and workflow skills for Claude Code. Not a production application. |
| `reamaze-mcp-server` | TypeScript MCP server | Small Re:amaze connector exposing conversation lookup and human-reviewed reply drafting to compatible agents. |
| `pressed-floral-app-v2` | Expo / React Native prototype | Minimal Expo 55 starter/prototype. It currently has no meaningful product functionality; do not confuse it with `pressed-floral-app-master`. |

## Local sibling checkouts

On the standard Pressed Floral workspace, this repository is commonly alongside these
checkouts under the same parent directory:

```text
../Support-Assistant
../pressed-floral-api-master
../pressed-floral-app-master
../pf-platform
../pressedfloral-scorecards
../mainsite-pressed-floral
../pf-layer-manifest-admin
../shipping-label-generation
../pf-staff-pwa
../pf-chat-agent
```

Not every organization repository is necessarily cloned locally. Refresh the inventory
with `gh repo list pressedfloral-digital --limit 100` before assuming this map is exhaustive.
