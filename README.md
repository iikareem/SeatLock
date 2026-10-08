# SeatLock

Serverless ticket-drop backend on AWS. Prevents double-selling, keeps group bookings atomic, and refunds cancelled events exactly once.

![status](https://img.shields.io/badge/status-in%20development-orange)
![language](https://img.shields.io/badge/TypeScript-core-3178c6)
![language](https://img.shields.io/badge/Go-tooling-00add8)
![iac](https://img.shields.io/badge/IaC-AWS%20CDK-ff9900)

---

## About

SeatLock is a portfolio project that models the hard parts of a high-demand ticket sale: concurrent seat claiming, group adjacency, payment uncertainty, and mass refunds under rate limits.

It targets a realistic on-sale scenario: tens of thousands of buyers, a few thousand seats, families that need adjacent seats, an unreliable payment provider, and an event that may be cancelled mid-sale.

The system is fully serverless. Core services are TypeScript; operational tooling (mock payment provider, sweeper, reconciler, auditor, load generator) is Go. Infrastructure is AWS CDK.

| Goal | Outcome |
|---|---|
| Concurrency safety | A seat is never sold twice |
| Payment safety | Retries and duplicates never double-charge |
| Atomic groups | Adjacent seats are held completely or not at all |
| Cancellation | Every paid order is refunded once, within provider rate limits |

This is a learning and portfolio system, not production ticketing software. Payment and gate scanning are simulated.

---

## Technologies

### Programming languages

| Language | Use |
|---|---|
| TypeScript | Core business logic (holds, orders, saga steps, cancellation, refunds) and CDK infrastructure |
| Go | Mock payment provider, hold sweeper, reconciler, stream relay, load generator, auditor |

### Frameworks and tools

| Tool | Role |
|---|---|
| AWS CDK (TypeScript) | Infrastructure as code |
| Node.js 20+ | Runtime for TypeScript Lambdas and CDK |
| Docker | Local emulator and reproducible tooling |
| MiniStack | Local AWS emulator for development and failure tests |

### AWS services

| Service | Role |
|---|---|
| API Gateway | Public HTTP API with throttling, validation, and JWT authorizers |
| Amazon Cognito | Fan authentication and admin group for cancellation |
| AWS Lambda | Holds, orders, saga steps, cancel, and refund workers |
| Amazon DynamoDB | Events, seats, orders, ledger, idempotency, refund batches |
| DynamoDB Streams | Change events relayed to EventBridge |
| AWS Step Functions | Purchase saga with compensation |
| Amazon SQS (+ DLQ) | Order buffering and rate-limited refund queue |
| Amazon EventBridge | Domain events (email, audit, analytics) |
| EventBridge Scheduler | Hold sweeper and reconciler schedules |
| Amazon SNS + SES | Notifications and email delivery |
| Amazon S3 | Signed tickets, refund reports, optional seat-map frontend |
| AWS KMS | Encryption at rest and ticket signing |
| Secrets Manager / SSM Parameter Store | Secrets and tunable configuration |
| Amazon CloudFront | Optional CDN for the seat-map frontend |
| Amazon CloudWatch + AWS X-Ray | Logs, metrics, alarms, and tracing |

---

## Table of Contents

1. [About](#about)
2. [Technologies](#technologies)
3. [The Problem](#the-problem)
4. [Guarantees](#guarantees)
5. [Design Challenges](#design-challenges)
6. [How It Works](#how-it-works)
7. [Architecture](#architecture)
8. [Tech Stack Rationale](#tech-stack-rationale)
9. [Data Model](#data-model)
10. [Key Design Decisions](#key-design-decisions)
11. [Failure Scenarios](#failure-scenarios)
12. [API Reference](#api-reference)
13. [Repository Structure](#repository-structure)
14. [Getting Started](#getting-started)
15. [Testing and Results](#testing-and-results)
16. [Observability](#observability)
17. [Security](#security)
18. [Cost](#cost)
19. [Roadmap](#roadmap)
20. [Limitations](#limitations)
21. [License](#license)

---

## The Problem

High-demand ticket sales repeatedly fail in the same ways:

- The same seat is sold to two buyers
- A buyer is charged but never receives a ticket
- A retry or duplicate message charges someone twice
- A family of four is split across the venue, or left with a partial hold
- The API collapses under the on-sale burst

Cancellation makes it worse. Thousands of refunds must pass through a throttled payment provider. Some calls fail. No order should be refunded twice, and none should be forgotten.

SeatLock addresses these failure modes with managed AWS services only.

## Guarantees

| # | Guarantee | Meaning |
|---|---|---|
| 1 | One seat, one buyer | A seat is never sold twice under concurrent claim |
| 2 | One purchase, one charge | Client retries, duplicate messages, and crashes do not double-charge |
| 3 | No charge without a ticket | Mid-purchase failure returns both money and seat |
| 4 | Together or not at all | A group hold succeeds completely or fails cleanly |
| 5 | Cancelled means refunded once | Every paid order is refunded once, within provider rate limits |

## Design Challenges

Two questions drive the design:

> What happens when a 5-minute seat hold expires while payment is still in flight?

> What happens when 5,000 refunds must go through a provider limited to 50 requests per second, while some purchases are still mid-saga?

| Challenge | Why it is hard |
|---|---|
| Overselling under concurrency | Thousands of buyers compete for the same seats at once |
| Exactly-once effect | At-least-once delivery can deliver the same message twice |
| Unknown outcomes | A payment call times out; success is ambiguous |
| Hold expiry race | The hold expires while payment is in progress |
| TTL lag | DynamoDB TTL deletion can lag by minutes and cannot be trusted for correctness |
| Hot keys | Popular seats create contention on single partitions |
| Traffic spikes | Bursts must be absorbed without losing requests |
| Compensation | Failure after a seat is taken must undo state safely |
| Group atomicity | Holding four seats means four writes that must all succeed or all fail |
| Overlapping groups | Two groups want overlapping seats; one must lose with no partial holds |
| Cancellation race | The event is cancelled while purchases are mid-saga |
| Refund backpressure | The provider throttles; the system must slow down without losing work |
| Double refunds | Retries must never refund the same order twice |
| Unknown refund outcomes | A refund times out; the money may or may not have returned |

---

## How It Works

SeatLock uses a two-level flow: a cheap concurrency gate, then a durable purchase saga.

### Level 1: Hold

`POST /events/{eventId}/holds` performs a conditional write on one seat or a group of seats:

```
AVAILABLE → HELD   (holdId, owner, expiresAt = now + 5 minutes)
```

- No order, payment, or saga at this stage
- Cheap enough to absorb a flood of clicks
- The conditional write is the concurrency gate; losers get an immediate conflict
- There is no timer process. Hold validity is `status` and `expiresAt`, checked at decision time

### Group booking

Holding seats one by one risks a partial hold (three of four succeed). SeatLock claims a group atomically:

1. The client requests `groupSize` seats in a section, or names specific seats (cap default: 8).
2. The server reads the row (seat IDs are zero-padded and sorted) and finds consecutive free blocks.
3. It attempts one block with `TransactWriteItems`. Every seat must be `AVAILABLE` (or have an expired hold), or the transaction is rejected.
4. On conflict, it re-reads and tries the next candidate block, up to a bounded number of attempts.
5. Transaction conflicts retry with jittered backoff.
6. If nothing fits, the client receives `409` and no seat remains held.

All seats in a group share one `holdId`, one expiry, and one order. The saga locks, confirms, and releases them as a unit.

```
Group A wants seats 10-13        Group B wants seats 12-15
        │                                │
        └──────── both run a transaction ┘
                         │
          one commits, the other is cancelled
          cleanly. No seat is left half-held.
```

This path exercises DynamoDB transaction semantics, per-item cancellation reasons, the 2x write cost of transactions, and conflict handling as a normal outcome.

### Level 2: Order

`POST /orders` stays fast. It:

1. Checks the idempotency key
2. Verifies the caller owns the hold and it has not expired
3. Checks the event is still on sale
4. Creates the order as `PENDING`
5. Enqueues a message on SQS
6. Returns `202 Accepted`

Heavy work runs in a Step Functions saga.

### Seat state machine

```
                 hold                    start payment
   AVAILABLE ───────────► HELD ───────────────────────► PAYING
       ▲                    │                              │
       │  hold expired      │ expired (checked at          │ confirmed
       │  (sweeper/check)   │ decision time)               ▼
       │                    ▼                            SOLD
       └────────────────  AVAILABLE ◄──── payment failed ──┘
                                          (compensation)
```

`PAYING` solves the hold-expiry race. While payment runs, the seat stays protected until `payUntil`, even if the original hold has expired.

### Purchase saga (AWS Step Functions)

| # | Step | Behavior |
|---|---|---|
| 1 | VerifyHold | Confirms ownership, event on sale, and enough time to pay |
| 2 | LockSeatForPayment | `HELD → PAYING` for all seats in the hold; sets `payUntil` |
| 3 | AuthorizePayment | Reserves funds (does not capture); idempotent |
| 4 | CheckPaymentStatus | After timeout, queries the provider for the outcome |
| 5 | ConfirmSeat | `PAYING → SOLD` only if the same `holdId` still owns the seats |
| 6 | CapturePayment | Captures the authorized amount |
| 7 | IssueTicket | Issues one ticket per seat, signs with KMS, stores in S3 |
| 8 | MarkConfirmed | Sets the order to `CONFIRMED` |

Compensation paths: `VoidAuthorization`, `RefundPayment`, `ReleaseSeat`, `MarkFailed`, `MarkRefunded`.

Authorize first, capture last. If the seat cannot be confirmed, the system voids a reservation. No money moved, so no refund is required.

```
VerifyHold → LockSeatForPayment → AuthorizePayment → ConfirmSeat
                                      │ unknown         │ fail
                                      ▼                 ▼
                               CheckPaymentStatus    VoidAuthorization
                                                     → ReleaseSeat
                                                     → MarkFailed

ConfirmSeat → CapturePayment → IssueTicket → MarkConfirmed
                                   │ fail
                                   ▼
                              RefundPayment → ReleaseSeat → MarkRefunded
```

Every step is idempotent, with retries and backoff, a timeout, and a catch that routes to the correct compensation.

### Event cancellation and mass refunds

When an event is cancelled, SeatLock stops selling, finishes or fails in-flight purchases, and refunds every paid order.

Event lifecycle:

```
ON_SALE ──► CANCELLING ──► CANCELLED
                │
                └─ new holds and orders rejected immediately
```

Flow:

1. Admin cancels via `POST /admin/events/{eventId}/cancel`. A conditional write moves `ON_SALE → CANCELLING`. New holds and orders are rejected; `VerifyHold` fails for work that has not started paying.
2. The refund orchestrator queries orders by status (GSI), creates a `RefundBatch`, and enqueues one refund job per order.
3. Refund workers run with capped concurrency to respect provider rate limits. On `429`, the message returns to the queue with a longer delay.
4. Each refund is idempotent: key derived from order ID, plus a conditional ledger `REFUND` write.
5. On timeout, the worker queries refund status before retrying.
6. Success sets the order to `REFUNDED`; DynamoDB Streams triggers the fan notification.
7. Atomic counters on `RefundBatch` track progress. When complete, a report is written to S3.
8. Persistent failures go to a DLQ, raise an alarm, and can be replayed.
9. Mid-saga purchases finish or fail normally. The orchestrator sweeps again until no non-terminal orders remain; the reconciler finds confirmed orders in cancelled events without a refund.
10. Ticket verification checks event status, so cancelled-event tickets are rejected even with a valid signature.

```
Admin ─► cancel-event ─► Events table (ON_SALE → CANCELLING)
                             │
                             ▼
                    refund-orchestrator
              (pages through orders, creates RefundBatch)
                             │
                             ▼
                      SQS refund queue  ──► DLQ ──► alarm + replay
                             │
                             ▼
                      refund-worker (capped concurrency)
                      │  idempotent per order
                      ▼
               Payment provider (rate limited)
                      │
                      ▼
   Ledger REFUND ─► Order REFUNDED ─► Streams ─► email to fan
                      │
                      ▼
          RefundBatch counters ─► complete ─► report in S3
```

The cancellation path covers backpressure, idempotency at scale, partial failure, and recovery after the happy path breaks.

---

## Architecture

```
                        ┌──────────────┐
   Fan (browser) ─────► │  CloudFront  │ ──► S3 (seat map frontend, optional)
        │               └──────────────┘
        ▼
┌─────────────────┐  JWT   ┌──────────┐
│  API Gateway    │ ─────► │ Cognito  │  (fan users + admin group)
│ (+ throttling)  │        └──────────┘
└───────┬─────────┘
        │
        ▼
┌─────────────────┐     ┌───────────────┐
│ Lambda (TS):    │ ──► │  DynamoDB     │  Events, Seats, Orders, Idempotency,
│ hold, order,    │     └───────┬───────┘  Ledger, RefundBatches
│ cancel-event    │             │ Streams
└───────┬─────────┘             ▼
        │                ┌───────────────┐
        ▼                │ Lambda (Go):  │ ──► EventBridge ──► email, audit,
┌─────────────────┐      │ stream-relay  │                     analytics
│  SQS + DLQ      │      └───────────────┘
└───────┬─────────┘
        ▼
┌─────────────────┐  start  ┌──────────────────────────────┐
│ Lambda: saga    │ ──────► │ Step Functions (saga)        │
│ starter         │         │ + compensation paths         │
└─────────────────┘         └──────┬───────────────────────┘
                                   │
          ┌────────────────────────┼─────────────────────┐
          ▼                        ▼                     ▼
  Mock payment provider      Ticket issuer         Notifications
  (Go, with chaos config)    (S3 + KMS signing)    (SNS → SQS → SES)

  Cancellation path:
  cancel-event → refund-orchestrator → SQS refunds (+DLQ) → refund-worker
                                                           → payment provider

  EventBridge Scheduler ──► hold sweeper (Go) + reconciler (Go)
  CloudWatch + X-Ray ─────► logs, metrics, alarms, traces
  Auditor (Go) ───────────► independent check of all invariants after a run
```

---

## Tech Stack Rationale

| Service / Tool | Role | Why |
|---|---|---|
| API Gateway | Public HTTP API | Throttling, validation, and authorizers before Lambda |
| Cognito | Authentication and roles | JWT auth; user ID from token; admin group for cancellation |
| Lambda | Business logic | Scales with bursts; forces explicit concurrency and retry design |
| DynamoDB | Persistent data | Conditional writes and transactions for atomic seat and group claims |
| DynamoDB Streams | Change events | Change and event stay coupled without a separate outbox |
| Step Functions (Standard) | Purchase saga | Durable execution with visible history and compensation |
| SQS + DLQ | Buffering and refund queue | Absorbs spikes, caps concurrency, captures poison messages |
| EventBridge | Domain events | Decouples producers from consumers |
| EventBridge Scheduler | Sweeper and reconciler | Managed scheduling without cron servers |
| SNS + SES | Notifications | Fan-out and email, including refund notices |
| S3 | Tickets and refund reports | Durable storage with presigned downloads |
| KMS | Encryption and signing | Tamper-evident tickets; customer-managed keys |
| Secrets Manager / SSM | Secrets and config | Keys out of code; tunable hold time, group cap, refund rate |
| CloudWatch + X-Ray | Observability | Logs, metrics, alarms, and traces across saga and refunds |
| AWS CDK (TypeScript) | Infrastructure as code | Repeatable environments and reviewable changes |
| TypeScript | Core services | Critical money and seat rules in one typed codebase |
| Go | Tooling and workers | Concurrency-friendly workers, auditor, and load generator |
| MiniStack | Local AWS emulator | Fast local development and automated failure tests |

---

## Data Model

### Events

| Attribute | Notes |
|---|---|
| `eventId` (PK) | Event identifier |
| `status` | `ON_SALE`, `CANCELLING`, `CANCELLED` |
| `cancelledAt`, `refundBatchId` | Set when cancellation starts |

### Seats

| Attribute | Notes |
|---|---|
| `eventId` (PK) | Event identifier |
| `seatId` (SK) | Zero-padded (e.g. `A-12-07`) so a row is one range query |
| `status` | `AVAILABLE`, `HELD`, `PAYING`, `SOLD` |
| `holdId`, `holdOwner` | Current hold; a group shares one `holdId` |
| `expiresAt` | Hold deadline; correctness reads this, not TTL |
| `payUntil` | Payment deadline, set on entering `PAYING` |
| `orderId` | Set when sold |
| `version` | Optimistic locking |

Hold one seat:

```
UpdateItem
  SET status = HELD, holdId = :h, holdOwner = :u, expiresAt = :exp
  CONDITION status = AVAILABLE
         OR (status = HELD AND expiresAt < :now)
```

Hold a group (all or nothing):

```
TransactWriteItems [
  Update seat A-12-10  (same SET and CONDITION as above)
  Update seat A-12-11
  Update seat A-12-12
  Update seat A-12-13
]
# If any condition fails, the whole transaction is cancelled
# and the reason for each item is returned.
```

Confirm a sale (all seats of the order):

```
TransactWriteItems [
  Update each seat:
    SET status = SOLD, orderId = :o
    CONDITION holdId = :h AND status = PAYING
]
```

### Orders

`orderId` (PK), `userId` (GSI), `eventId` + `status` (GSI for refund orchestration), `seatIds`, `holdId`, `amount`, `status` (`PENDING`, `CONFIRMED`, `FAILED`, `REFUND_PENDING`, `REFUNDED`), `executionArn`, `idempotencyKey`, `createdAt`.

### Ledger

Append-only entries (`AUTH`, `CAPTURE`, `VOID`, `REFUND`) with a conditional write on the idempotency key so duplicates are rejected.

### RefundBatches

`batchId` (PK), `eventId`, `total`, `succeeded`, `failed`, `status` (`RUNNING`, `COMPLETE`, `COMPLETE_WITH_FAILURES`), `startedAt`, `finishedAt`, `reportKey`. Counters use atomic `ADD`.

### Idempotency

`key` (PK), `status`, stored `response`, and a `ttl` for cleanup.

---

## Key Design Decisions

Summaries below. Full records live in [`docs/adr`](docs/adr).

| Decision | Choice | Reason |
|---|---|---|
| Hold expiry | Check `expiresAt` at decision time; never trust TTL | TTL deletion can lag by minutes |
| Orchestration | Step Functions over pure choreography | Visible failure paths and execution history |
| Seat modeling | One item per seat, not a counter | Spreads writes; avoids one hot partition |
| Payment protection | `PAYING` state with `payUntil` | Prevents the hold-expiry race |
| Payment flow | Authorize, confirm seat, then capture | Avoids most refunds |
| Event publishing | DynamoDB Streams relay | Change and event cannot drift apart |
| Storage | DynamoDB only | Conditional writes and transactions cover needs without VPC setup |
| Language split | TypeScript core, Go tooling | Critical rules in one language; Go where concurrency helps |
| Group holds | `TransactWriteItems` with a size cap | All-or-nothing without a lock manager; accepts 2x write cost |
| Adjacent seats | Server-side search over a sorted row | Client cannot be trusted to pick a valid block |
| Refund fan-out | SQS with capped worker concurrency | Direct backpressure; Distributed Map is a documented alternative |
| Refund safety | Idempotency key per order + conditional ledger write | Duplicates never refund twice |
| Cancellation | Event status checked at hold, order, and saga entry | Single source of truth for selling state |
| Verification | Independent Go auditor | The system does not grade its own homework |

---

## Failure Scenarios

| Scenario | Handling |
|---|---|
| Two buyers take the same seat | Conditional write: one wins, one gets a conflict |
| Client retries the purchase | Idempotency key returns the stored result |
| SQS delivers a message twice | Execution name equals order ID; duplicate start is rejected |
| Payment times out | Query provider status by idempotency key before retry or release |
| Duplicate payment callback | Ledger conditional write rejects the second entry |
| Hold expires during payment | `PAYING` lock protects the seat until `payUntil` |
| Hold expires and another buyer takes the seat | `ConfirmSeat` fails, then void or refund |
| TTL deletes late | Correctness uses `expiresAt` checks and the sweeper |
| Ticket issuance fails | Retry, then refund and release the seat |
| Lambda crashes mid-step | Step Functions retries the idempotent step |
| Inconsistent data slips through | Scheduled reconciler repairs it |
| Payment provider is down | Retry with backoff, then `FAILED` |
| Message keeps failing | DLQ, alarm, replay tool |
| Only 3 of 4 group seats are free | Transaction rejected; nothing held; try another block or `409` |
| Two groups want overlapping seats | One commits; the other cancels cleanly |
| Transaction conflict under load | Jittered backoff, bounded attempts, then clear error |
| Group hold expires mid-payment | Whole group stays `PAYING` until `payUntil` |
| Event cancelled mid-saga | New steps rejected; captured money refunded by cancel flow or reconciler |
| Provider throttles refunds (`429`) | Longer queue delay; capped concurrency |
| Refund call times out | Check refund status by idempotency key before retry |
| Duplicate refund message | Idempotency key and conditional ledger write |
| Refund keeps failing | DLQ; batch ends `COMPLETE_WITH_FAILURES`; alarm; replay |
| Orchestrator crashes halfway | Batch record and idempotent jobs make rerun safe |
| Fan opens a ticket for a cancelled event | Verification checks event status and rejects |

---

## API Reference

Write endpoints require a Cognito JWT. User ID comes from the token, never the request body. Admin endpoints require the admin group.

| Method | Path | Description |
|---|---|---|
| `GET` | `/events/{eventId}/seats` | Seat availability for the map |
| `POST` | `/events/{eventId}/holds` | Hold seats (`seatIds` or `groupSize`). Returns `holdId`, `seatIds`, `expiresAt`, or `409` |
| `POST` | `/orders` | Submit a purchase for a hold. Requires `Idempotency-Key`. Returns `202` |
| `GET` | `/orders/{orderId}` | Poll order status |
| `POST` | `/admin/events/{eventId}/cancel` | Cancel event and start refund batch (admin) |
| `GET` | `/admin/events/{eventId}/refunds` | Refund batch progress (admin) |

Hold a group of four:

```http
POST /events/evt_001/holds
Authorization: Bearer <jwt>

{ "groupSize": 4, "section": "A", "adjacent": true }
```

```http
HTTP/1.1 201 Created
{
  "holdId": "h_01HXYZ",
  "seatIds": ["A-12-10", "A-12-11", "A-12-12", "A-12-13"],
  "expiresAt": "2026-11-01T20:05:00Z"
}
```

Submit the order:

```http
POST /orders
Idempotency-Key: 7b1c9a52-0c3e-4f5e-9a3d-2f1a8d6e4b10
Authorization: Bearer <jwt>

{ "holdId": "h_01HXYZ", "eventId": "evt_001" }
```

```http
HTTP/1.1 202 Accepted
{ "orderId": "ord_01HABC", "status": "PENDING" }
```

Check refund progress:

```http
GET /admin/events/evt_001/refunds
```

```http
HTTP/1.1 200 OK
{ "batchId": "rb_01HDEF", "total": 3120, "succeeded": 2840, "failed": 12, "status": "RUNNING" }
```

---

## Repository Structure

```
seatlock/
├── infra/                    # AWS CDK app (TypeScript)
│   ├── lib/                  # Stacks and constructs
│   └── bin/
├── services/                 # Core services (TypeScript)
│   ├── hold-seat/            # single and group holds
│   ├── create-order/
│   ├── saga-steps/           # verify, lock, authorize, confirm, capture, issue
│   ├── cancel-event/
│   ├── refund-orchestrator/
│   ├── refund-worker/
│   └── shared/               # DynamoDB helpers, idempotency, types
├── go/                       # Go components
│   ├── mock-payment/         # configurable provider (latency, errors, duplicates, rate limit)
│   ├── hold-sweeper/
│   ├── reconciler/
│   ├── stream-relay/
│   ├── loadgen/              # concurrent load generator
│   └── auditor/              # independent invariant checker
├── tests/
│   ├── integration/
│   └── failure/              # failure-injection scenarios
├── docs/
│   ├── adr/                  # architecture decision records
│   ├── runbook.md
│   └── contracts.md          # seat states, conditions, event shapes
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js 20+ and npm
- Go 1.22+
- Docker
- AWS CLI and CDK (`npm install -g aws-cdk`)
- An AWS account (required for cloud deploy and load tests)

### Run locally with MiniStack

[MiniStack](https://github.com/ministackorg/ministack) is an open-source local AWS emulator for development and failure tests.

```bash
# Start the emulator
docker run -p 4566:4566 ministackorg/ministack

# Point the SDKs at it
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

# Install and deploy
npm install
cd infra && npx cdk deploy --all
```

See MiniStack docs for CDK bootstrapping in your setup. Reset emulator state between runs with `POST http://localhost:4566/_ministack/reset`.

### Deploy to AWS

```bash
unset AWS_ENDPOINT_URL
aws configure          # or use SSO
cd infra
npx cdk bootstrap
npx cdk deploy --all --context stage=dev
```

Set a billing alarm before deploying.

### Tests

```bash
npm test                    # unit and integration tests
go test -race ./go/...      # Go tests with the race detector
npm run test:failure        # failure-injection scenarios
```

### Load test

```bash
cd go/loadgen
go run . \
  --api https://<your-api-url> \
  --event evt_001 \
  --users 50000 \
  --group-share 0.3 \
  --concurrency 1000 \
  --duration 30s
```

### Cancellation and audit

```bash
curl -X POST https://<your-api-url>/admin/events/evt_001/cancel \
  -H "Authorization: Bearer <admin-jwt>"

curl https://<your-api-url>/admin/events/evt_001/refunds \
  -H "Authorization: Bearer <admin-jwt>"

cd go/auditor && go run . --event evt_001
```

### Clean up

```bash
cd infra && npx cdk destroy --all
```

---

## Testing and Results

### Test layers

| Layer | Coverage |
|---|---|
| Unit | Conditional-write logic, idempotency, state transitions, group block search |
| Integration | Full flow against MiniStack |
| Failure injection | Payment timeouts, duplicate callbacks, mid-saga crashes, hold expiry during payment, overlapping groups, refund throttling |
| Load | Burst of purchase attempts (including groups) against real AWS |
| Cancellation | Cancel at a chosen moment with in-flight orders |
| Audit | Independent Go program checks invariants from raw data |

### Targets

| Metric | Target |
|---|---|
| Seats oversold | 0 |
| Duplicate charges | 0 |
| Charged without a ticket (after reconciliation) | 0 |
| Partially held or partially sold groups | 0 |
| Burst handled | ~1,000 requests/second for 30 seconds |
| API response time (p99) | under 300 ms |
| Time to final state | under 60 seconds |
| Injected inconsistencies fixed by reconciler | 100% |
| Paid orders refunded after cancellation | 100% |
| Duplicate refunds | 0 |
| Provider refund rate limit exceeded | 0 sustained violations |
| Time to refund ~5,000 orders | under 10 minutes (example target) |

### Results

Results will be filled with measured numbers from real AWS runs. Estimates are not published as results.

| Metric | Target | Result |
|---|---|---|
| Seats available | 5,000 | |
| Purchase attempts | | |
| Group requests (share of attempts) | | |
| Seats oversold | 0 | |
| Duplicate charges | 0 | |
| Partially held or sold groups | 0 | |
| Orders confirmed / failed / refunded | | |
| p99 API latency | < 300 ms | |
| Burst sustained | 1,000 rps for 30 s | |
| Time to final state (p99) | < 60 s | |
| Orders refunded after cancellation | 100% | |
| Duplicate refunds | 0 | |
| Time to complete refund batch | | |
| Refunds sent to DLQ | | |
| Cost per 1,000 purchases | | |

Bottlenecks and fixes will be documented after load testing.

---

## Observability

Metrics:

- Orders accepted, confirmed, failed, refunded
- Conditional check failures (contention)
- Transaction cancellations and conflicts for group holds
- SQS queue age and DLQ depth
- Saga duration and failure rate
- Reconciliation fixes
- Refund queue backlog, refund rate, provider throttles, batch progress

Alarms:

- DLQ not empty (purchase or refund queue)
- Queue age too high
- Saga failure rate above threshold
- API 5xx rate
- Lambda throttles and DynamoDB throttled requests
- Refund batch not progressing

Tracing and logs:

- X-Ray across API, SQS, Step Functions, and Lambda
- Structured JSON logs with order ID and batch ID as correlation IDs

---

## Security

- JWT on every write endpoint; user ID from the token only
- Admin group for cancellation and refund endpoints
- Least-privilege IAM role per function and state machine
- Encryption at rest with KMS for tables, queues, and S3
- Tickets signed with KMS; verification also checks event status
- Secrets in Secrets Manager; configuration in Parameter Store
- Short-lived presigned URLs for ticket downloads
- Rate limiting and throttling at the API layer

---

## Cost

- DynamoDB on-demand (transactions cost about twice a normal write)
- Serverless services with low cost at test volumes
- No NAT Gateways or always-on containers
- Billing alarm before any deployment
- Stacks destroyed after load tests

Measured cost per 1,000 purchases is reported in [Results](#results).

---

## Roadmap

- [ ] Stage 1: CDK foundation, single-seat `POST /holds`, seats table, Cognito auth
- [ ] Stage 2: Concurrency control, expiry logic, contention test
- [ ] Stage 3: Group holds with transactions, block search, overlap tests
- [ ] Stage 4: Orders, idempotency, SQS buffering
- [ ] Stage 5: Step Functions saga with compensation (group-aware), mock payment provider
- [ ] Stage 6: Streams relay, EventBridge, notifications
- [ ] Stage 7: Signed tickets, KMS, secrets, least-privilege IAM
- [ ] Stage 8: DLQ replay, hold sweeper, reconciler
- [ ] Stage 9: Event cancellation, refund orchestrator, rate-limited workers, batch tracking
- [ ] Stage 10: Dashboards, alarms, tracing
- [ ] Stage 11: Go auditor, load and failure tests, results table, cost report
- [ ] Stage 12: CI/CD, dev and prod environments, canary deploys

Possible extensions:

- Waiting room and bot defenses
- Live seat map over WebSockets
- Seat map frontend on CloudFront and S3
- Postgres ledger for a relational comparison
- Purchase analytics with Kinesis Firehose, S3, and Athena
- Partial cancellation (refund selected ticket types only)

---

## Limitations

- Learning and portfolio project, not production software
- Payment provider and ticket scanning are simulated
- Local runs use an emulator; performance numbers come only from real AWS
- No real payment processing, PCI compliance, or fraud detection
- Group booking assumes simple row-based adjacency (no accessibility or venue-geometry rules)

---

## License

MIT. See [LICENSE](LICENSE).
