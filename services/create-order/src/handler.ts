/**
 * Create order Lambda — validates hold, enqueues saga work, returns 202.
 * TODO: idempotency key, order PENDING, SQS enqueue.
 */

export async function handler(_event: unknown): Promise<{ statusCode: number; body: string }> {
  return {
    statusCode: 501,
    body: JSON.stringify({ message: "TODO: implement create-order" }),
  };
}
