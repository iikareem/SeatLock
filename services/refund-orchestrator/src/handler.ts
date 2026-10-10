/**
 * Refund orchestrator — pages paid orders, creates RefundBatch, enqueues jobs.
 * TODO: GSI query by event + status, SQS fan-out, batch counters.
 */

export async function handler(_event: unknown): Promise<void> {
  throw new Error("TODO: implement refund-orchestrator");
}
