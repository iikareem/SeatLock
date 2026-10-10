/**
 * Refund worker — rate-limited idempotent refunds against the payment provider.
 * TODO: capped concurrency, 429 backoff, ledger REFUND, order REFUNDED.
 */

export async function handler(_event: unknown): Promise<void> {
  throw new Error("TODO: implement refund-worker");
}
