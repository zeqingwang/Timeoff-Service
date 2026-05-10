/** Stable idempotency key for filing usage on approval (TRD §16.1). */
export function approvalIdempotencyKey(requestId: string): string {
  return `${requestId}:approval`;
}
