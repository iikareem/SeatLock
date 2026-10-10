/**
 * Cancel event Lambda — ON_SALE → CANCELLING, kick off refund orchestration.
 * TODO: conditional event status write, reject new holds/orders.
 */

export async function handler(_event: unknown): Promise<{ statusCode: number; body: string }> {
  return {
    statusCode: 501,
    body: JSON.stringify({ message: "TODO: implement cancel-event" }),
  };
}
