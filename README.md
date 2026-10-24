# RaktKhoj — Find Blood in Minutes

A mobile-first blood-bank discovery and emergency donor coordination MVP based on the supplied product brief and UI reference. The current experience is a safe local demo: directory profiles are synthetic, inventory is never represented as available, and no real SMS or WhatsApp messages are sent.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open the Vite URL (normally http://localhost:5173). The Express demo API runs on port 4000 and Vite proxies `/api` requests. Requests are stored in memory by the API and in the browser's local storage for a convenient demo. Restarting the API clears its in-memory records.

To run only the production frontend build:

```bash
npm run build
```

The API can be run with `npm run start`. Copy `.env.example` to `.env` before configuring services. `docker compose up -d` starts PostgreSQL with PostGIS; it does not connect the demo API to the database yet.

## Included

- Responsive landing page, emergency request wizard, bank directory, donor discovery, request tracking, donor registration and admin demo view.
- Five-step request flow with validation, accessible controls, optional geolocation permission, request review, and explicit sharing consent.
- Express REST routes for requests, timeline, matching placeholder, cancellation, donor registration and responses.
- Zod request validation and structured API errors.
- Prisma data model for users, donors, requests, facilities, inventory, matches, notifications, consent and audit records.
- Synthetic facility/donor examples with clear simulation and verification labels.

## Simulated versus connected

| Capability | State |
|---|---|
| Request wizard and tracking | Working local demo; API memory plus browser persistence |
| Donor and facility listings | Synthetic, display-only examples |
| Inventory | No inventory claims or values are provided |
| Donor matching and messages | Not connected; API explicitly returns a simulated empty match result |
| WhatsApp, SMS, email | Not connected; no messages are sent |
| Authentication and roles | Not implemented; admin page is a demo view, not protected |
| PostgreSQL/PostGIS | Compose and Prisma schema provided; app persistence/migrations not connected |
| Map | Illustrative static map panel, not a live geocoder or tile map |
| Telugu | Language selector stub; translation strings are not yet wired |
| AI assistant | Not connected |

## Safety and production work

This product coordinates potential donors and facilities. It does not confirm blood availability, compatibility, donation, or medical eligibility. All such decisions must be made by qualified blood-bank professionals. Do not deploy the demo with real patient data. Production use needs authentication, authorization, verified facility sources, consent-aware matching, secure persistence, abuse controls, retention/deletion flows, provider webhook verification, and clinical review of matching rules.

REST endpoints are documented inline in `server/index.ts`; `GET /api/health` reports the current demo mode. `prisma/schema.prisma` is the starting typed data model. The matching endpoint intentionally returns no candidates until an approved component-specific source and rules are configured.
