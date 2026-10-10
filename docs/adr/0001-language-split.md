# ADR 0001: TypeScript core, Go tooling

## Status

Accepted

## Context

SeatLock needs typed business rules for money and seats, plus concurrency-heavy workers for load generation, sweeping, reconciliation, and auditing.

## Decision

- **TypeScript** owns core Lambdas (holds, orders, saga steps, cancel, refunds) and CDK.
- **Go** owns tooling and ops workers (mock payment, sweeper, reconciler, stream-relay, loadgen, auditor).

Languages do not share a process. They couple only through DynamoDB schemas and message contracts in `docs/contracts.md`.

## Consequences

- Critical invariants stay in one typed codebase.
- Go is a natural fit for concurrent workers and independent verification.
- Two build/toolchains to maintain.
