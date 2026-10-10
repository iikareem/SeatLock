/**
 * Shared types and helpers for TypeScript services.
 * TODO: DynamoDB helpers, idempotency, seat/order/ledger types.
 */

export type SeatStatus = "AVAILABLE" | "HELD" | "PAYING" | "SOLD";
export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED";
export type EventStatus = "ON_SALE" | "CANCELLING" | "CANCELLED";

export const PLACEHOLDER = true;
