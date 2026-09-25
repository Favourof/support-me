import { notify } from './notify';

/**
 * A `fetch` that failed because the network (or the server behind it) was
 * unreachable. Carries a `retry` that re-runs the same request, so callers —
 * and the offline banner — can offer a concrete recovery action instead of a
 * dead end.
 */
export class NetworkError extends Error {
  retry: () => Promise<Response>;

  constructor(message: string, retry: () => Promise<Response>) {
    super(message);
    this.name = 'NetworkError';
    this.retry = retry;
  }
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}

export interface FailedRequest {
  message: string;
  retry: () => Promise<Response>;
}

let lastFailure: FailedRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function setFailure(failure: FailedRequest | null) {
  lastFailure = failure;
  emit();
}

/** Subscribe to the most recent network failure (or its resolution). */
export function subscribeToNetworkFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastNetworkFailure(): FailedRequest | null {
  return lastFailure;
}

/** Clears the stored failure — used when connectivity checks succeed. */
export function clearNetworkFailure() {
  if (lastFailure) setFailure(null);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function reportNetworkFailure(input: RequestInfo | URL, init?: RequestInit): NetworkError {
  const retry = async (): Promise<Response> => {
    try {
      const res = await fetch(input, init);
      setFailure(null);
      return res;
    } catch (err) {
      if (isAbortError(err)) throw err;
      const next = reportNetworkFailure(input, init);
      throw next;
    }
  };

  const error = new NetworkError(
    "Could not reach the server. Check your connection, then try again.",
    retry
  );
  setFailure({ message: error.message, retry });
  notify.error('Connection problem', error.message, {
    action: {
      label: 'Retry',
      onClick: () => {
        void retry()
          .then(() => notify.success('Request succeeded'))
          .catch(() => {
            // reportNetworkFailure already surfaced a fresh retry toast.
          });
      },
    },
  });
  return error;
}

/**
 * Drop-in replacement for `fetch` on user-facing requests: on a network
 * failure it records the failure (so the offline banner can offer a persistent
 * retry), shows a toast with a Retry action, and throws a `NetworkError`.
 * Callers should skip their own generic error toast for `NetworkError` to
 * avoid double-reporting. Bodies must be re-sendable (strings/JSON), since a
 * retry reuses the same `init`.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    const res = await fetch(input, init);
    clearNetworkFailure();
    return res;
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw reportNetworkFailure(input, init);
  }
}
