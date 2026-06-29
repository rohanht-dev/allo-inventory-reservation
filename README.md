# Allo Inventory Reservation System

A full-stack inventory reservation platform built for Allo's take-home engineering assessment. The system solves the race condition at checkout by temporarily holding stock units for a customer during the payment window, preventing overselling across multiple warehouses.

**Live Demo:** `https://allo-inventory-reservation.vercel.app`
**GitHub:** `https://github.com/rohanht-dev/allo-inventory-reservation`

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Architecture Overview](#architecture-overview)
- [Concurrency & Race Condition Handling](#concurrency--race-condition-handling)
- [Stock Reservation Flow](#stock-reservation-flow)
- [Reservation Expiry Strategy](#reservation-expiry-strategy)
- [API Documentation](#api-documentation)
- [Tech Stack & Decisions](#tech-stack--decisions)
- [Local Setup](#local-setup)
- [Deployment](#deployment)
- [Trade-offs & Known Limitations](#trade-offs--known-limitations)
- [What I'd Do With More Time](#what-id-do-with-more-time)

---

## Problem Statement

When a customer proceeds to checkout, payment can take several minutes (3DS flows, UPI confirmations, wallet redirects). During that window, other shoppers may be looking at the same product.

- **Decrement stock at add-to-cart** → inventory looks depleted, 80% of abandoned carts tank conversion
- **Decrement stock at payment time** → two customers can pay for the same unit; ops cleans up the mess manually

**Solution:** A temporary reservation that holds units for 10 minutes. Payment success → confirmed, stock permanently decremented. Payment failure or timeout → stock released back to available.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Next.js App                          │
│                                                             │
│  ┌──────────────┐         ┌──────────────────────────────┐  │
│  │   Frontend   │         │         API Routes           │  │
│  │              │         │                              │  │
│  │ /            │────────▶│ GET  /api/products           │  │
│  │ (product     │         │ GET  /api/warehouses         │  │
│  │  listing)    │         │ POST /api/reservations       │  │
│  │              │         │ POST /api/reservations/:id/  │  │
│  │ /checkout/id │────────▶│      confirm                 │  │
│  │ (countdown + │         │ POST /api/reservations/:id/  │  │
│  │  actions)    │         │      release                 │  │
│  └──────────────┘         └──────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
     ┌────────▼────────┐               ┌──────────▼────────┐
     │  Neon (Postgres) │               │  Upstash (Redis)  │
     │                  │               │                   │
     │  Products        │               │  Distributed lock │
     │  Warehouses      │               │  Idempotency keys │
     │  Stock           │               │                   │
     │  Reservations    │               └───────────────────┘
     └──────────────────┘
```

**Data model summary:**

- `Product` — SKU details (name, price, description)
- `Warehouse` — physical locations
- `Stock` — a join table keyed on `(productId, warehouseId)` with two counts: `total` (physical units) and `reserved` (currently held by pending reservations). Available stock is always `total - reserved`.
- `Reservation` — a record with status (`PENDING | CONFIRMED | RELEASED`), `expiresAt`, and an optional `idempotencyKey`.

Keeping `total` and `reserved` as separate columns (rather than a single `available` column) means we never have to reconstruct available stock from multiple sources. Available is always a pure read: `total - reserved`.

---

## Concurrency & Race Condition Handling

This is the core of the system. Two simultaneous requests for the last unit of a SKU must result in exactly one success and one `409`.

### The approach: Redis distributed lock + Postgres transaction

When a reservation request arrives:

1. **Acquire a Redis lock** scoped to `lock:{productId}:{warehouseId}` using `SET NX PX` (set-if-not-exists with a 5-second TTL). This is atomic at the Redis level — only one caller can win.
2. If the lock is not acquired, return `503` immediately (the client can retry in milliseconds).
3. Inside the lock, run a **Prisma transaction** that reads the current stock, checks availability, increments `reserved`, and creates the `Reservation` row — all atomically.
4. Release the lock in a `finally` block, but only if the lock value still matches ours (preventing a process that ran long from releasing someone else's lock).

```
Request A ──▶ SET lock:p1:w1 "uuid-a" NX PX 5000 ──▶ OK (lock acquired)
Request B ──▶ SET lock:p1:w1 "uuid-b" NX PX 5000 ──▶ nil (lock held)
                                                    ──▶ 503 (retry)

Request A (inside lock):
  BEGIN TRANSACTION
    SELECT stock WHERE productId=p1 AND warehouseId=w1  → available = 1
    UPDATE stock SET reserved = reserved + 1             → reserved = 1
    INSERT reservation ...
  COMMIT
  DEL lock:p1:w1
```

**Why Redis + Postgres rather than Postgres alone?**

Postgres advisory locks or `SELECT FOR UPDATE` would also work for a single-node deployment. Redis gives us a lock that works across multiple Vercel serverless function instances without needing a persistent connection per process. For a higher-traffic system, you could use Redlock across multiple Redis nodes for stronger guarantees.

---

## Stock Reservation Flow

```
Customer clicks "Reserve"
        │
        ▼
POST /api/reservations
        │
        ├── Acquire Redis lock (5s TTL)
        │         │
        │    Lock acquired?
        │    No  ──▶ 503 (retry)
        │    Yes ──▶ continue
        │
        ├── Prisma transaction
        │         ├── Read stock row
        │         ├── available = total - reserved
        │         ├── available >= quantity?
        │         │     No  ──▶ rollback ──▶ 409
        │         │     Yes ──▶ reserved += quantity
        │         │             create Reservation (PENDING, expiresAt = now+10m)
        │         └── commit
        │
        ├── Release Redis lock
        │
        └── 201 → redirect to /checkout/:id
                        │
              ┌─────────┴──────────┐
              │                    │
         User confirms         User cancels / timer expires
              │                    │
   POST /confirm              POST /release
              │                    │
   status=CONFIRMED           status=RELEASED
   reserved -= qty            reserved -= qty
   total -= qty               (total unchanged)
   (permanently sold)         (units back to available)
```

---

## Reservation Expiry Strategy

**Production approach: Vercel Cron Job**

A cron job runs every minute and calls `GET /api/reservations/expire`. This endpoint:

1. Finds all reservations where `status = PENDING AND expiresAt < NOW()`
2. For each expired reservation, runs a transaction to decrement `stock.reserved` and set `status = RELEASED`

```json
// vercel.json
{
  "crons": [{ "path": "/api/reservations/expire", "schedule": "* * * * *" }]
}
```

The endpoint is protected by a `CRON_SECRET` header that Vercel sends automatically, so it can't be triggered by arbitrary requests.

**Why not lazy cleanup on read?**

Lazy cleanup (releasing on the next read that touches the record) is simpler but has a meaningful downside: if a product sells out and all pending reservations are expired, the item shows `0 available` until someone reads it. With a cron, expired stock is freed within ~60 seconds regardless of traffic, which matters most for low-inventory SKUs.

**Why not a long-running background worker?**

Vercel's serverless environment doesn't support long-running processes. The cron approach maps cleanly to the platform. On a VPS/container deployment, a queue worker (BullMQ + Redis) would be a better fit — jobs would be enqueued at reservation creation time and fired exactly at `expiresAt`.

---

## API Documentation

### `GET /api/products`

Returns all products with available stock per warehouse.

**Response `200`:**
```json
[
  {
    "id": "clx...",
    "name": "Sony WH-1000XM5 Headphones",
    "description": "Industry-leading noise cancellation headphones",
    "price": 29999,
    "stock": [
      {
        "id": "clx...",
        "warehouseId": "clx...",
        "total": 5,
        "reserved": 1,
        "available": 4,
        "warehouse": { "id": "clx...", "name": "Mumbai Central", "location": "Mumbai, MH" }
      }
    ]
  }
]
```

---

### `GET /api/warehouses`

Returns all warehouses.

**Response `200`:**
```json
[
  { "id": "clx...", "name": "Mumbai Central", "location": "Mumbai, MH" },
  { "id": "clx...", "name": "Delhi North", "location": "Delhi, DL" }
]
```

---

### `POST /api/reservations`

Reserves units for a product at a specific warehouse.

**Headers (optional):**
```
Idempotency-Key: <uuid>
```

**Request body:**
```json
{ "productId": "clx...", "warehouseId": "clx...", "quantity": 1 }
```

**Responses:**

| Status | Meaning |
|--------|---------|
| `201` | Reservation created. Body: full reservation object with `expiresAt`. |
| `400` | Validation error (missing/invalid fields). |
| `409` | Not enough stock available. |
| `503` | Lock contention — safe to retry immediately. |

**Response `201`:**
```json
{
  "id": "clx...",
  "status": "PENDING",
  "quantity": 1,
  "expiresAt": "2025-01-01T12:10:00.000Z",
  "product": { "name": "Sony WH-1000XM5 Headphones", "price": 29999 },
  "warehouse": { "name": "Mumbai Central" }
}
```

---

### `POST /api/reservations/:id/confirm`

Confirms the reservation (payment succeeded). Permanently decrements stock.

**Responses:**

| Status | Meaning |
|--------|---------|
| `200` | Confirmed (or already confirmed — idempotent). |
| `404` | Reservation not found. |
| `410` | Reservation expired or already released. |

---

### `POST /api/reservations/:id/release`

Releases the reservation early (payment failed or user cancelled). Frees the held units.

**Responses:**

| Status | Meaning |
|--------|---------|
| `200` | Released (or already released — idempotent). |
| `404` | Reservation not found. |
| `409` | Cannot release a confirmed reservation. |

---

### `GET /api/reservations/expire` *(internal — Vercel Cron)*

Releases all PENDING reservations past their `expiresAt`. Protected by `Authorization: Bearer <CRON_SECRET>`.

---

## Tech Stack & Decisions

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | Next.js 14 (App Router) | Required by the brief; co-locates API routes and UI |
| Language | TypeScript | End-to-end type safety; shared Zod schemas between API and forms |
| Database | Postgres via Neon | Hosted, serverless-friendly, free tier; ACID transactions for stock updates |
| ORM | Prisma | Type-safe queries, migration tooling, readable schema |
| Locking | Upstash Redis | Serverless-compatible distributed lock; `SET NX PX` is atomic |
| Validation | Zod | Schema defined once, used in API handlers and can be reused in frontend forms |
| UI | Tailwind + shadcn/ui | Fast to build functional UI without design bikeshedding |
| Deployment | Vercel | Zero-config Next.js deployment; native cron support |

---

## Local Setup

### Prerequisites

- Node.js 18+
- A [Neon](https://neon.tech) account (free tier)
- An [Upstash](https://upstash.com) account (free tier)

### 1. Clone the repository

```bash
git clone https://github.com/your-username/allo-inventory
cd allo-inventory
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
# Neon connection string (found in your Neon project dashboard)
DATABASE_URL="postgresql://user:password@ep-xxx.neon.tech/neondb?sslmode=require"

# Upstash Redis (found in your Upstash database details)
UPSTASH_REDIS_REST_URL="https://xxx.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-token-here"

# Any random string — used to protect the cron endpoint
CRON_SECRET="replace-with-a-random-secret"
```

### 3. Run database migrations

```bash
npx prisma migrate dev --name init
```

### 4. Seed the database

```bash
npx prisma db seed
```

This creates 2 warehouses (Mumbai, Delhi) and 3 products (Sony headphones, AirPods Pro, Galaxy Watch) with varying stock levels, including some low-stock items to demonstrate the race condition handling.

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Deployment

The app is deployed on **Vercel** with **Neon** (Postgres) and **Upstash** (Redis).

### Steps to deploy your own instance

1. Push the repository to GitHub.
2. Import the project on [vercel.com](https://vercel.com).
3. Add the following environment variables in the Vercel project settings:
   - `DATABASE_URL`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `CRON_SECRET`
4. Deploy. Vercel will automatically pick up the cron job from `vercel.json`.
5. After the first deployment, run migrations and seed against the production database:

```bash
npx prisma migrate deploy
npx prisma db seed
```

The cron job (`/api/reservations/expire`) runs every minute in production and is called by Vercel's infrastructure with `Authorization: Bearer <CRON_SECRET>` automatically.

---

## Trade-offs & Known Limitations

**Redis lock returns 503 on contention, not a queue**  
When two requests race and one loses the lock, it gets a 503 instead of waiting and retrying server-side. This keeps the request lifecycle simple and predictable, but it means the frontend needs to retry. In practice the lock is held for milliseconds, so a single client-side retry immediately succeeds. A server-side retry loop would be cleaner but adds latency to every contested request.

**Cron granularity is 1 minute**  
Expired reservations are released within ~60 seconds of expiry, not exactly at `expiresAt`. For a 10-minute hold window this is acceptable. The frontend countdown timer is client-side and accurate to the second; the backend cleanup just lags slightly behind.

**No authentication**  
Reservations are not tied to a user session. Anyone with a reservation ID can confirm or release it. Adding auth (NextAuth.js or Clerk) would scope reservations to verified users and prevent tampering.

**Single quantity per reservation**  
The UI only supports reserving 1 unit at a time. The API and data model both support arbitrary quantities, so this is purely a frontend limitation.

**No optimistic UI updates on the product listing**  
After a reservation is created, the product listing page doesn't reflect the reduced stock until a manual refresh. A polling interval or WebSocket connection would fix this.

---

## What I'd Do With More Time

- **Auth:** Tie reservations to authenticated users (NextAuth.js). Prevent users from having multiple active reservations on the same SKU.
- **BullMQ expiry worker:** Replace the cron job with a Redis-backed job queue. Enqueue a `releaseReservation` job at creation time with a `delay` equal to the TTL. This gives exact expiry timing and is more reliable than polling.
- **Redlock:** For production multi-node Redis, use the Redlock algorithm across 3–5 Redis nodes instead of a single-node lock, which has a failure window during Redis restarts.
- **Webhook for payment providers:** Add a `POST /api/webhooks/payment` endpoint that receives events from Stripe/Razorpay and auto-confirms or releases reservations based on payment outcome, rather than relying on the frontend to call confirm/release.
- **Admin dashboard:** A view showing all active reservations, expiry times, and stock levels in real time — useful for ops teams.
- **E2E tests:** Playwright tests covering the full reserve → countdown → confirm flow, and a concurrency test that fires two simultaneous reserve requests for the last unit and asserts exactly one 201 and one 409.