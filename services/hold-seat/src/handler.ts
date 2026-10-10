/**
 * Hold seat Lambda — single and group holds.
 * TODO: conditional writes / TransactWriteItems for AVAILABLE → HELD.
 */

export async function handler(_event: unknown): Promise<{ statusCode: number; body: string }> {
  return {
    statusCode: 501,
    body: JSON.stringify({ message: "TODO: implement hold-seat" }),
  };
}
