# Contracts

Shared contracts between TypeScript services and Go tooling.
Seat states, conditions, event shapes, and message payloads live here.

## Seat status

`AVAILABLE` → `HELD` → `PAYING` → `SOLD`

## Event status

`ON_SALE` → `CANCELLING` → `CANCELLED`

## Order status

`PENDING` → `CONFIRMED` | `FAILED` | `REFUND_PENDING` → `REFUNDED`

## TODO

- Conditional write expressions for hold / confirm / release
- Idempotency key formats (order, payment, refund)
- SQS message shapes (order enqueue, refund job)
- EventBridge detail types (email, audit, analytics)
- Ledger entry kinds (`AUTH`, `CAPTURE`, `VOID`, `REFUND`)
