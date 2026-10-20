/**
 * The retry rule and the retry delay.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 — "**`shouldRetry`**
 * (source, complete): retries on `401` when the response used a cached token
 * that has not already been refreshed, honours the `x-should-retry` response
 * header in both directions, and retries `408`, `409`, `429`, and any status
 * `>= 500`."
 *
 * ## What is observed and what is a implementation choice
 *
 * Observed:
 *
 *   - the **retryable statuses**: `408`, `409`, `429` and every status
 *     `>= 500`; `400`, `401`, `403` and `404` are not retryable;
 *   - the **`x-should-retry` header**, honoured in **both** directions: it
 *     makes a non-retryable status retryable and a retryable status
 *     non-retryable;
 *   - the **`401` with a cached token**, which is retryable once the token has
 *     been invalidated.
 *
 * Implementation choices (the audit does not pin them):
 *
 *   - the **backoff shape**: an exponential backoff of `500 ms × 2^attempt`,
 *     capped at `8 000 ms`. The delay is **deterministic** — there is no
 *     jitter — so that a test can pin it and so that two runs of the same
 *     request behave identically;
 *   - the **`retry-after` clamp**: a server's `retry-after` is honoured, but
 *     it is clamped to **its own, larger** maximum (`60 000 ms`), so that a
 *     hostile or mistaken header cannot park a turn for an hour — but a
 *     server's explicit instruction is not truncated to the backoff's
 *     `8 000 ms` either;
 *   - the **`retry-after` parsing**: the header is either a number of seconds
 *     or an HTTP-date; anything else is ignored and the backoff is used.
 */

/** The header the target honours in both directions. **Observed** (audit §2.2). */
export const SHOULD_RETRY_HEADER = 'x-should-retry';

/** The header that asks for a delay before the next attempt. */
export const RETRY_AFTER_HEADER = 'retry-after';

/** The first delay of the exponential backoff. **Implementation choice.** */
export const RETRY_BASE_DELAY_MS = 500;

/** The longest delay this implementation waits between two attempts. **Implementation choice.** */
export const RETRY_MAX_DELAY_MS = 8_000;

/**
 * The longest delay a server's `retry-after` may ask for.
 *
 * **Implementation choice.** It is deliberately **larger** than the backoff's cap: the
 * backoff is this implementation's own shape, while a `retry-after` is the server's
 * explicit instruction, and truncating it to the backoff's maximum would
 * ignore the server by a factor of seven and a half.
 */
export const RETRY_AFTER_MAX_DELAY_MS = 60_000;

/** The number of retries a request gets when nothing else says. **Implementation choice.** */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * The response a delay is derived from.
 *
 * The plan fixes the shape: the status and the headers.
 */
export interface RetryResponseLike {
  /** The response status. */
  status: number;
  /** The response headers. */
  headers: Headers;
}

/**
 * Read the `x-should-retry` header.
 *
 * The value is compared **exactly**, as the shared driver rule compares it:
 * only `true` and `false` override the status rules, and anything else is
 * **absent**. (A `Headers` object has already stripped the leading and
 * trailing whitespace of a header value.)
 */
export function readShouldRetry(headers: Headers | null | undefined): boolean | undefined {
  if (headers === null || headers === undefined) return undefined;
  const raw = headers.get(SHOULD_RETRY_HEADER);
  if (raw === null) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * Parse a `retry-after` header into a delay in milliseconds.
 *
 * The header is either a number of **seconds** or an **HTTP-date**. A value
 * that is neither is **absent**, and the caller falls back to the backoff.
 *
 * @param value the header's value.
 * @param now the current time, in milliseconds since the epoch; used to turn
 *   an HTTP-date into a delay. It is a parameter, so that the answer is a
 *   function of the caller's inputs.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // The seconds form is checked **first**: `Date.parse('3')` is a valid date
  // (the year 3), so a numeric header must never reach the date parser.
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.round(seconds * 1000);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * The delay before the next attempt.
 *
 * The delay is a **function of its inputs only** — there is no jitter, and
 * the clock is read only through the `now` argument — so two calls with the
 * same arguments always answer the same number.
 *
 * @param attempt the zero-based index of the attempt that just failed: `0` is
 *   the first request, so `retryDelayMs(0)` is the delay before the second
 *   one.
 * @param response the failed response, when there was one.
 * @param now the current time, in milliseconds since the epoch. It is only
 *   read when the response carries an HTTP-date `retry-after`, and it makes
 *   that answer a function of the inputs rather than of the wall clock.
 *
 * The rules:
 *
 *   - a response that carries `x-should-retry: false` yields **no** delay: the
 *     caller must not retry it, and a caller that consults only the delay
 *     waits for nothing;
 *   - a response that carries a usable `retry-after` yields **that** delay,
 *     clamped to the `retry-after` maximum (which is **not** the backoff's);
 *   - otherwise the delay is the exponential backoff.
 */
export function retryDelayMs(attempt: number, response?: RetryResponseLike, now: number = Date.now()): number {
  if (response !== undefined) {
    if (readShouldRetry(response.headers) === false) return 0;
    const after = parseRetryAfter(response.headers.get(RETRY_AFTER_HEADER), now);
    if (after !== undefined) return Math.min(after, RETRY_AFTER_MAX_DELAY_MS);
  }
  return backoffMs(attempt);
}

/**
 * The exponential backoff of an attempt.
 *
 * **Implementation choice**: `500 ms × 2^attempt`, capped at `8 000 ms`.
 */
export function backoffMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return RETRY_BASE_DELAY_MS;
  const scaled = RETRY_BASE_DELAY_MS * 2 ** Math.floor(attempt);
  if (!Number.isFinite(scaled)) return RETRY_MAX_DELAY_MS;
  return Math.min(scaled, RETRY_MAX_DELAY_MS);
}
