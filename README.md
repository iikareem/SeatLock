# SeatLock 🎟️🔒

**A serverless ticket-drop engine on AWS that never double-sells a seat, seats families together or not at all, and refunds everyone exactly once when a show is cancelled.**

> 100,000 fans. 5,000 seats. Families who need four seats together. A flaky payment provider. And an artist who might cancel.

![status](https://img.shields.io/badge/status-in%20development-orange)
![language](https://img.shields.io/badge/TypeScript-core-3178c6)
![language](https://img.shields.io/badge/Go-tooling-00add8)
![iac](https://img.shields.io/badge/IaC-AWS%20CDK-ff9900)

---

## Technologies

### Programming languages

| Language | Where it is used |
|---|---|
| **TypeScript** | Core business logic (holds, orders, saga steps, cancellation, refunds) and AWS CDK infrastructure |
| **Go** | Tooling and workers: mock payment provider, hold sweeper, reconciler, stream relay, load generator, auditor |

### Frameworks and tools

| Tool | Role |
|---|---|
| **AWS CDK (TypeScript)** | Infrastructure as code — stacks, constructs, environments |
| **Node.js 20+** | Runtime for TypeScript Lambdas and CDK |
| **Docker** | Local AWS emulator (MiniStack) and reproducible tooling |
| **MiniStack** | Local AWS emulator for development and failure tests |

### AWS services

| Service | Role in SeatLock |
|---|---|
| **API Gateway** | Public HTTP API with throttling, validation, and JWT authorizers |
| **Amazon Cognito** | Fan authentication and admin group for cancellation |
| **AWS Lambda** | Business logic: holds, orders, saga steps, cancel, refund workers |
| **Amazon DynamoDB** | Events, seats, orders, ledger, idempotency, refund batches |
| **DynamoDB Streams** | Change events relayed to EventBridge (no separate outbox table) |
| **AWS Step Functions** | Purchase saga with compensation paths |
| **Amazon SQS (+ DLQ)** | Order buffering and rate-limited refund queue |
| **Amazon EventBridge** | Domain events (email, audit, analytics) |
| **EventBridge Scheduler** | Hold sweeper and reconciler schedules |
| **Amazon SNS + SES** | Notifications and fan email (including refunds) |
| **Amazon S3** | Signed tickets, refund reports, optional seat-map frontend |
| **AWS KMS** | Encryption at rest and ticket signing |
| **Secrets Manager / SSM Parameter Store** | Secrets and tunable config (hold time, group cap, refund rate) |
| **Amazon CloudFront** | Optional CDN for the seat-map frontend |
| **Amazon CloudWatch + AWS X-Ray** | Logs, metrics, alarms, and distributed tracing |

---

## Table of Contents

1. [Technologies](#technologies)
2. [The Problem](#the-problem)
3. [The Promises](#the-promises)
4. [Why It's Hard](#why-its-hard)
5. [How It Works](#how-it-works)
   - [Level 1: Hold](#level-1-hold-just-changes-the-seat)
   - [Group Booking](#group-booking-four-seats-together-or-nothing)
   - [Level 2: Order](#level-2-order-starts-the-whole-logic)
   - [Seat State Machine](#seat-state-machine)
   - [The Purchase Saga](#the-purchase-saga-aws-step-functions)
   - [Event Cancellation and Mass Refunds](#event-cancellation-and-mass-refunds)
6. [Architecture](#architecture)
7. [Tech Stack and Why](#tech-stack-and-why)
8. [Data Model](#data-model)
9. [Key Design Decisions](#key-design-decisions)
10. [Failure Scenarios](#failure-scenarios)
11. [API Reference](#api-reference)
12. [Repository Structure](#repository-structure)
13. [Getting Started](#getting-started)
14. [Testing and Results](#testing-and-results)
15. [Observability](#observability)
16. [Security](#security)
17. [Cost](#cost)
18. [Roadmap](#roadmap)
19. [What I Learned](#what-i-learned)
20. [Limitations](#limitations)
21. [License](#license)

---

## The Problem

When a big concert goes on sale, the same things go wrong every time:

- The **same seat gets sold to two people**
- People are **charged but never receive a ticket**
- A retry or a duplicate message **charges someone twice**
- A family of four ends up **scattered across the venue**, or holding two seats they can't use
- The site **falls over** under the burst of traffic

And when the show is cancelled, it gets worse: thousands of refunds must go out through a payment provider that throttles you, some will fail, and nobody should be refunded twice or forgotten.

SeatLock is a backend built to prevent all of this, using only managed AWS services and no servers to run.

## The Promises

| # | Promise | What it means |
|---|---|---|
| 1 | **One seat, one buyer** | A seat is never sold twice, even when thousands of people click at the same moment |
| 2 | **One purchase, one charge** | Client retries, duplicate messages, and crashes never double-charge anyone |
| 3 | **No charge without a ticket** | If anything fails mid-purchase, both the money and the seat are returned |
| 4 | **Together or not at all** | A group of seats is held completely or not at all, never partially |
| 5 | **Cancelled means refunded, exactly once** | When an event is cancelled, every paid order is refunded once, within the provider's rate limits, and nothing is lost |

## Why It's Hard

The sharpest questions this project answers:

> **What happens when your 5-minute seat hold expires while your payment is still in flight?**
>
> **What happens when 5,000 refunds must go through a provider that only accepts 50 requests per second, while some purchases are still mid-flight?**

| Challenge | Why it is hard |
|---|---|
| Overselling under concurrency | Thousands of buyers compete for the same seats at the same moment |
| Exactly-once *effect* | At-least-once delivery means the same message can arrive twice |
| Unknown outcomes | A payment call times out. Did it succeed or not? |
| Hold expiry race | The hold expires while payment is in progress |
| TTL is not instant | DynamoDB TTL deletion can lag by minutes, so it cannot be trusted for correctness |
| Hot keys | Popular seats create contention on single partitions |
| Traffic spikes | A burst must be absorbed without losing requests |
| Compensation | A failure after the seat was taken must undo state safely |
| **Group atomicity** | Holding 4 seats means 4 writes that must all succeed or all fail |
| **Overlapping groups** | Two groups want overlapping seats, so one must lose cleanly with no partial holds left behind |
| **Cancellation race** | The event is cancelled while purchases are mid-saga |
| **Refund backpressure** | The provider throttles refunds, so you must slow down without losing any |
| **Double refunds** | Retries and duplicate messages must never refund the same order twice |
| **Unknown refund outcomes** | A refund times out. Did the money go back or not? |

---

## How It Works

SeatLock uses a **two-level flow**: a cheap, fast first step, then the full process.

### Level 1: Hold (just changes the seat)

`POST /events/{eventId}/holds` does one thing: a conditional write on the seat (or on several seats at once for a group).

```
AVAILABLE → HELD   (holdId, owner, expiresAt = now + 5 minutes)
```

- No order, no payment, no saga
- Cheap, so it can absorb a flood of clicks
- It is the **concurrency gate**: the conditional write decides who wins, and everyone else gets an immediate "seat taken"
- There is **no timer**. The hold is data (`status` and `expiresAt`) checked at the moment of each decision

### Group Booking: four seats together, or nothing

A family wants four adjacent seats. Holding them one by one is dangerous: if only three succeed, the fan is stuck with a partial hold while the fourth seat is gone.

SeatLock holds a group **atomically**:

1. The client asks for `groupSize` seats (for example 4) in a section, or names specific seats. Group size is capped (default 8).
2. The server reads the row (seat IDs are zero-padded and sorted, so a row is one range query) and finds candidate blocks of **consecutive** free seats.
3. It tries one block with a single `TransactWriteItems`: every seat must be `AVAILABLE` (or have an expired hold), or the whole transaction is rejected.
4. If a seat was taken in the meantime, it re-reads and tries the next candidate block, up to a bounded number of attempts.
5. If transactions conflict with each other, it retries with jittered backoff.
6. If nothing fits, the client gets a clear `409` and no seat is left held.

All seats in a group share **one `holdId`**, one expiry, and one order. The saga then locks, confirms, and releases them as a unit, again with transactions.

```
Group A wants seats 10-13        Group B wants seats 12-15
        │                                │
        └──────── both run a transaction ┘
                         │
          one commits, the other is cancelled
          cleanly. No seat is ever left half-held.
```

**Why this is interesting:** it forces you to learn DynamoDB transaction semantics, the cancellation reasons per item, the 2x write cost of transactions, and why a conflict is an expected outcome to handle, not an error to hide.

### Level 2: Order (starts the whole logic)

`POST /orders` stays fast. It only:

1. Checks the idempotency key
2. Verifies the caller owns the hold and it has not expired
3. Checks the event is still on sale
4. Creates the order as `PENDING`
5. Puts a message on SQS
6. Returns `202 Accepted`

The heavy work then runs in a Step Functions saga.

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

The `PAYING` state is what solves the hold-expiry race. While a payment is running, the seat stays protected until `payUntil`, even if the original hold has run out.

### The purchase saga (AWS Step Functions)

| # | Step | What it does |
|---|---|---|
| 1 | **VerifyHold** | Confirms the caller owns the hold, the event is on sale, and enough time remains to pay |
| 2 | **LockSeatForPayment** | `HELD → PAYING` for all seats in the hold, sets `payUntil` |
| 3 | **AuthorizePayment** | Reserves funds (does not take them), idempotent |
| 4 | **CheckPaymentStatus** | After a timeout, asks the provider what happened |
| 5 | **ConfirmSeat** | `PAYING → SOLD` for all seats, only if the same `holdId` still owns them |
| 6 | **CapturePayment** | Takes the authorized money |
| 7 | **IssueTicket** | Generates one ticket per seat, signs it with KMS, stores it in S3 |
| 8 | **MarkConfirmed** | Sets the order to `CONFIRMED` |

**Compensation:** `VoidAuthorization`, `RefundPayment`, `ReleaseSeat`, `MarkFailed`, `MarkRefunded`.

**Authorize first, capture last.** If the seat cannot be confirmed, the system only cancels a reservation. No money moved, so no refund is needed.

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

Every step is **idempotent**, has **retries with backoff**, a **timeout**, and a **catch** that routes to the right compensation.

### Event Cancellation and Mass Refunds

The artist cancels. SeatLock must stop selling, deal with purchases that are mid-flight, and refund every paid order reliably.

**Event lifecycle**

```
ON_SALE ──► CANCELLING ──► CANCELLED
                │
                └─ new holds and orders rejected immediately
```

**The flow**

1. **Admin cancels the event.** `POST /admin/events/{eventId}/cancel` (admin role only). A conditional write moves the event `ON_SALE → CANCELLING`. From this moment, new holds and new orders are rejected, and `VerifyHold` in the saga fails for anything that has not started paying.
2. **A refund batch is created.** The orchestrator queries all orders for the event by status (through a GSI), creates a `RefundBatch` record with the total count, and enqueues **one refund job per order** onto an SQS queue.
3. **Workers refund within the provider's limits.** A refund worker consumes the queue with **capped concurrency** so the provider's rate limit is respected. If the provider throttles (`429`), the message returns to the queue with a longer delay.
4. **Each refund is idempotent.** The idempotency key is derived from the order ID, and the ledger `REFUND` entry is a conditional write, so a duplicate message can never refund twice.
5. **Unknown outcomes are checked, not guessed.** If a refund call times out, the worker asks the provider for the refund status before retrying.
6. **Orders and seats are updated.** A successful refund sets the order to `REFUNDED`, and the `OrderRefunded` event (through the DynamoDB Streams relay) triggers the fan's notification email.
7. **Progress is tracked.** Atomic counters on the `RefundBatch` record (`succeeded`, `failed`) show live progress. When they add up to `total`, the batch is marked complete and a report is written to S3.
8. **Failures are not lost.** Messages that keep failing go to a DLQ, trigger an alarm, and can be replayed after the cause is fixed.
9. **Late arrivals are caught.** Purchases that were mid-saga when cancellation started finish or fail normally. The orchestrator sweeps again until no order for the event is in a non-terminal state, and the reconciler finds any `CONFIRMED` order in a cancelled event that has no refund.
10. **Tickets are voided.** Ticket verification checks the event status, so a ticket for a cancelled event is rejected even though its signature is valid.

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

**Why this is interesting:** most projects only show the happy purchase path. A mass refund shows backpressure, idempotency at scale, handling of partial failure, and operating a system after something goes wrong.

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

## Tech Stack and Why

| Service / Tool | Role | Why it was chosen |
|---|---|---|
| **API Gateway** | Public HTTP API | Throttling, validation, and authorizers before Lambda runs |
| **Cognito** | Authentication and roles | Real JWT auth. The user ID always comes from the token, and an admin group protects cancellation |
| **Lambda** | Business logic | Scales with bursts, forces learning of concurrency and retries |
| **DynamoDB** | All persistent data | Conditional writes and transactions give atomic seat and group claiming, with low latency under load |
| **DynamoDB Streams** | Change events | Replaces an outbox table, so a change and its event cannot drift apart |
| **Step Functions (Standard)** | Purchase saga | Durable, auditable, with visible execution history |
| **SQS + DLQ** | Buffering and refund queue | Absorbs spikes, controls consumer concurrency to respect the provider limit, captures poison messages |
| **EventBridge** | Domain events | Decouples producers from consumers |
| **EventBridge Scheduler** | Sweeper and reconciler | Managed scheduling with no cron servers |
| **SNS + SES** | Notifications | Fan-out and email delivery, including refund notices |
| **S3** | Tickets and refund reports | Durable storage with presigned download links |
| **KMS** | Encryption and signing | Tamper-evident tickets, customer-managed keys |
| **Secrets Manager / SSM** | Secrets and config | Keeps keys out of code, allows tuning (hold time, group cap, refund rate) without redeploying |
| **CloudWatch + X-Ray** | Observability | Logs, metrics, alarms, and tracing across the saga and the refund flow |
| **AWS CDK (TypeScript)** | Infrastructure as code | Repeatable environments, reviewable changes |
| **TypeScript** | Core services | Critical business rules, including money and seat logic, live in one strong language |
| **Go** | Tooling and workers | Mock provider, sweeper, reconciler, auditor, and load generator |
| **MiniStack** | Local AWS emulator | Fast, free local development and automated failure tests |

---

## Data Model

### `Events`

| Attribute | Notes |
|---|---|
| `eventId` (PK) | Event identifier |
| `status` | `ON_SALE`, `CANCELLING`, `CANCELLED` |
| `cancelledAt`, `refundBatchId` | Set when cancellation starts |

### `Seats`

| Attribute | Notes |
|---|---|
| `eventId` (PK) | Event identifier |
| `seatId` (SK) | Zero-padded, e.g. `A-12-07`, so a row is a single range query |
| `status` | `AVAILABLE`, `HELD`, `PAYING`, `SOLD` |
| `holdId`, `holdOwner` | Identify the current hold. A group shares one `holdId` |
| `expiresAt` | Hold deadline. Correctness reads this, not TTL |
| `payUntil` | Payment deadline, set when the seat enters `PAYING` |
| `orderId` | Set when sold |
| `version` | Optimistic locking |

**Hold one seat**
```
UpdateItem
  SET status = HELD, holdId = :h, holdOwner = :u, expiresAt = :exp
  CONDITION status = AVAILABLE
         OR (status = HELD AND expiresAt < :now)
```

**Hold a group (all or nothing)**
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

**Confirm a sale (all seats of the order)**
```
TransactWriteItems [
  Update each seat:
    SET status = SOLD, orderId = :o
    CONDITION holdId = :h AND status = PAYING
]
```

### `Orders`

`orderId` (PK), `userId` (GSI), `eventId` + `status` (GSI, used by the refund orchestrator), `seatIds`, `holdId`, `amount`, `status` (`PENDING`, `CONFIRMED`, `FAILED`, `REFUND_PENDING`, `REFUNDED`), `executionArn`, `idempotencyKey`, `createdAt`.

### `Ledger`

Append-only entries (`AUTH`, `CAPTURE`, `VOID`, `REFUND`) with a conditional write on the idempotency key, so a duplicate is rejected.

### `RefundBatches`

`batchId` (PK), `eventId`, `total`, `succeeded`, `failed`, `status` (`RUNNING`, `COMPLETE`, `COMPLETE_WITH_FAILURES`), `startedAt`, `finishedAt`, `reportKey`. Counters are updated with atomic `ADD`.

### `Idempotency`

`key` (PK), `status`, stored `response`, and a `ttl` for cleanup.

---

## Key Design Decisions

Short summaries. Full records live in [`docs/adr`](docs/adr).

| Decision | Choice | Reason |
|---|---|---|
| Hold expiry | Check `expiresAt` at decision time, never trust TTL | TTL deletion can lag by minutes |
| Orchestration | Step Functions over pure choreography | Visible failure paths and execution history |
| Seat modeling | One item per seat, not a single counter | Spreads writes and avoids one hot partition |
| Payment protection | Add a `PAYING` state with `payUntil` | Prevents the hold-expiry race |
| Payment flow | Authorize, confirm seat, then capture | Avoids most refunds |
| Event publishing | DynamoDB Streams relay | Change and event cannot drift apart |
| Storage | DynamoDB only | Conditional writes and transactions cover every need, with no VPC setup |
| Language split | TypeScript core, Go tooling | Critical rules in one language, Go where concurrency helps |
| Group holds | `TransactWriteItems` with a group size cap | All-or-nothing without building a lock system, accepting 2x write cost and bounded retries |
| Adjacent seats | Server-side search over a sorted row | The client cannot be trusted to pick a valid block, and one range query reads a row |
| Refund fan-out | SQS queue with capped worker concurrency | Backpressure is direct and simple to tune. Step Functions Distributed Map is a documented alternative |
| Refund safety | Idempotency key per order plus conditional ledger write | Duplicates and retries can never refund twice |
| Cancellation | Event status as a state machine, checked at hold, order, and saga entry | A single source of truth for "are we still selling?" |
| Verification | An independent Go auditor | The system is not allowed to grade its own homework |

---

## Failure Scenarios

| Scenario | Handling |
|---|---|
| Two buyers take the same seat | Conditional write: one wins, one gets a conflict |
| Client retries the purchase | Idempotency key returns the stored result |
| SQS delivers a message twice | Execution name equals order ID, so a duplicate start is rejected |
| Payment times out | Query provider status by idempotency key before retrying or releasing |
| Duplicate payment callback | Ledger conditional write rejects the second entry |
| Hold expires during payment | `PAYING` lock protects the seat until `payUntil` |
| Hold expires and someone else took the seat | `ConfirmSeat` fails, then void or refund |
| TTL deletes late | Correctness uses `expiresAt` checks and the sweeper |
| Ticket issuance fails | Retry, then refund and release the seat |
| Lambda crashes mid-step | Step Functions retries the idempotent step |
| Inconsistent data slips through | Scheduled reconciler repairs it |
| Payment provider is down | Retry with backoff, then a clear `FAILED` state |
| Message keeps failing | Goes to DLQ, alarm fires, replay tool pushes it back |
| **Only 3 of 4 group seats are free** | The transaction is rejected, nothing is held, the server tries another block or returns `409` |
| **Two groups want overlapping seats** | One transaction commits, the other is cancelled cleanly. No partial holds |
| **Transaction conflict under load** | Retry with jittered backoff, bounded attempts, then a clear error |
| **Group hold expires mid-payment** | The whole group stays `PAYING` together until `payUntil` |
| **Event cancelled while a purchase is mid-saga** | New steps are rejected. If money was captured, the order is refunded by the cancel flow or the reconciler |
| **Provider throttles refunds (429)** | Message returns to the queue with a longer delay, and worker concurrency stays capped |
| **Refund call times out** | Check refund status by idempotency key before retrying |
| **Duplicate refund message** | Idempotency key and conditional ledger write prevent a second refund |
| **A refund keeps failing** | Goes to the DLQ, the batch ends `COMPLETE_WITH_FAILURES`, an alarm fires, replay after the fix |
| **Orchestrator crashes halfway** | The batch record and idempotent jobs make it safe to run again |
| **Fan opens a ticket for a cancelled event** | Verification checks the event status and rejects it |

---

## API Reference

All write endpoints require a Cognito JWT. The user ID is taken from the token, never from the request body. Admin endpoints require the admin group.

| Method | Path | Description |
|---|---|---|
| `GET` | `/events/{eventId}/seats` | Seat availability for the map |
| `POST` | `/events/{eventId}/holds` | Hold seats, either specific `seatIds` or a `groupSize` request. Returns `holdId`, `seatIds`, and `expiresAt`, or `409` if unavailable |
| `POST` | `/orders` | Submit a purchase for a hold. Requires an `Idempotency-Key` header. Returns `202` |
| `GET` | `/orders/{orderId}` | Poll order status |
| `POST` | `/admin/events/{eventId}/cancel` | Cancel an event and start the refund batch (admin only) |
| `GET` | `/admin/events/{eventId}/refunds` | Refund batch progress (admin only) |

**Hold a group of four together**
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

**Submit the order**
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

**Check refund progress**
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
│   ├── loadgen/              # concurrent load generator (singles, groups, cancellation)
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
- An AWS account (only needed for the final deployment and load test)

### Run locally with MiniStack

[MiniStack](https://github.com/ministackorg/ministack) is an open-source local AWS emulator. It lets you develop and run failure tests quickly, for free.

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

> Check the MiniStack documentation for how CDK bootstrapping works in your setup. Reset all emulator state between test runs with `POST http://localhost:4566/_ministack/reset`.

### Deploy to real AWS

```bash
unset AWS_ENDPOINT_URL
aws configure          # or use SSO
cd infra
npx cdk bootstrap
npx cdk deploy --all --context stage=dev
```

Set a **billing alarm** before deploying anything.

### Run tests

```bash
npm test                    # unit and integration tests
go test -race ./go/...      # Go tests with the race detector
npm run test:failure        # failure-injection scenarios
```

### Run the load test

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

### Simulate a cancellation and audit the result

```bash
# Cancel the event after the sale
curl -X POST https://<your-api-url>/admin/events/evt_001/cancel \
  -H "Authorization: Bearer <admin-jwt>"

# Watch refund progress
curl https://<your-api-url>/admin/events/evt_001/refunds \
  -H "Authorization: Bearer <admin-jwt>"

# Verify every invariant independently
cd go/auditor && go run . --event evt_001
```

### Clean up

```bash
cd infra && npx cdk destroy --all
```

---

## Testing and Results

### Test layers

| Layer | What it covers |
|---|---|
| Unit | Conditional-write logic, idempotency, state transitions, block search for groups |
| Integration | Full flow against MiniStack |
| Failure injection | Payment timeouts, duplicate callbacks, crashes mid-saga, hold expiry during payment, overlapping group requests, provider throttling during refunds |
| Load | Burst of purchase attempts, with a share of group requests, against real AWS |
| Cancellation | Cancel at a chosen moment, with orders still in flight |
| Audit | A separate Go program checks every invariant from the raw data |

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
| Time to refund all orders (about 5,000) | a defined target, for example under 10 minutes |

### Results

> ⚠️ **To be filled in with measured numbers from real AWS runs. Do not publish estimates as results.**

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

**Bottlenecks found and how they were fixed:** _(add after load testing)_

---

## Observability

**Metrics**
- Orders accepted, confirmed, failed, refunded
- Conditional check failures (contention indicator)
- Transaction cancellations and conflicts for group holds
- SQS queue age and DLQ depth
- Saga duration and failure rate
- Reconciliation fixes
- Refund queue backlog, refund rate per second, provider throttle responses, batch progress

**Alarms**
- DLQ not empty (purchase queue or refund queue)
- Queue age too high
- Saga failure rate above threshold
- API 5xx rate
- Lambda throttles and DynamoDB throttled requests
- Refund batch not progressing

**Tracing and logs**
- X-Ray tracing across API, SQS, Step Functions, and Lambda
- Structured JSON logs with the order ID and batch ID as correlation IDs

---

## Security

- JWT authentication on every write endpoint, with the user ID from the token only
- An admin group for cancellation and refund endpoints
- Least-privilege IAM role per function and state machine
- Encryption at rest with KMS for tables, queues, and S3
- Tickets carry a KMS signature so gate scanners can detect forgeries, and verification also checks the event status
- Secrets in Secrets Manager, configuration in Parameter Store
- Presigned, short-lived URLs for ticket downloads
- Rate limiting and throttling at the API layer

---

## Cost

- DynamoDB on-demand capacity (note that transactions cost about twice a normal write)
- Serverless services that cost little at test volumes
- No NAT Gateways or always-on containers
- Billing alarm set before any deployment
- Stacks destroyed after load tests

Measured cost per 1,000 purchases is reported in the [results](#results) section.

---

## Roadmap

- [ ] **Stage 1:** CDK foundation, single-seat `POST /holds`, seats table, Cognito auth
- [ ] **Stage 2:** Concurrency control, expiry logic, contention test
- [ ] **Stage 3:** Group holds with transactions, block search, overlap tests
- [ ] **Stage 4:** Orders, idempotency, SQS buffering
- [ ] **Stage 5:** Step Functions saga with compensation (group aware), mock payment provider
- [ ] **Stage 6:** Streams relay, EventBridge, notifications
- [ ] **Stage 7:** Signed tickets, KMS, secrets, least-privilege IAM
- [ ] **Stage 8:** DLQ replay, hold sweeper, reconciler
- [ ] **Stage 9:** Event cancellation, refund orchestrator, rate-limited refund workers, batch tracking
- [ ] **Stage 10:** Dashboards, alarms, tracing
- [ ] **Stage 11:** Go auditor, load and failure tests, results table, cost report
- [ ] **Stage 12:** CI/CD, dev and prod environments, canary deploys

**Possible extensions**
- Waiting room and bot defenses
- Live seat map over WebSockets
- Seat map frontend on CloudFront and S3
- Postgres ledger for a relational comparison
- Purchase analytics with Kinesis Firehose, S3, and Athena
- Partial cancellation (refund only some ticket types)

---

## What I Learned

_(Fill this in as you build. Honest, specific lessons make a README stand out. For example: what surprised you about DynamoDB transactions, how you tuned refund concurrency, what broke under load, what you would design differently.)_

---

## Limitations

- This is a **learning and portfolio project**, not production software
- The payment provider and ticket scanning are **simulated**
- Local runs use an emulator, so performance numbers come only from real AWS runs
- No real payment processing, PCI compliance, or fraud detection
- Group booking assumes simple row-based adjacency, with no accessibility or venue-geometry rules

---

## License

MIT. See [LICENSE](LICENSE).
