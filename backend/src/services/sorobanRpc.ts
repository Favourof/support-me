import { rpc } from "@stellar/stellar-sdk";

/** The public testnet endpoint used when no endpoint has been configured. */
export const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * The SDK's own RPC client is used by the subscription executor, while the
 * event listener and health probe use JSON-RPC directly. Keeping endpoint
 * selection and failover in one place prevents those callers from drifting
 * apart as more backend features are added.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
let lastSuccessfulEndpoint: string | null = null;

export function resetSorobanRpcFailoverState(): void {
  lastSuccessfulEndpoint = null;
}

export interface SorobanRpcOptions {
  /** Per-endpoint timeout. Defaults to SOROBAN_RPC_TIMEOUT_MS or 10 seconds. */
  timeoutMs?: number;
  /** Optional deadline for the complete failover sequence. */
  totalTimeoutMs?: number;
}

/**
 * Returns the configured endpoints in priority order.
 *
 * `SOROBAN_RPC_URLS` is the preferred comma-separated setting. The singular
 * `SOROBAN_RPC_URL` remains supported for existing deployments, and
 * `SOROBAN_RPC_ENDPOINTS` is accepted as a descriptive alias for new setups.
 */
export function getSorobanRpcUrls(): string[] {
  const configured =
    process.env.SOROBAN_RPC_URLS?.trim() ||
    process.env.SOROBAN_RPC_ENDPOINTS?.trim() ||
    process.env.SOROBAN_RPC_URL?.trim() ||
    DEFAULT_SOROBAN_RPC_URL;

  const urls = configured
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  return [...new Set(urls.length > 0 ? urls : [DEFAULT_SOROBAN_RPC_URL])];
}

export function getSorobanRpcTimeoutMs(fallback = DEFAULT_TIMEOUT_MS): number {
  const configured = Number(process.env.SOROBAN_RPC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function formatSorobanRpcEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid endpoint]";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function orderedEndpoints(): string[] {
  const endpoints = getSorobanRpcUrls();
  if (!lastSuccessfulEndpoint || !endpoints.includes(lastSuccessfulEndpoint)) {
    return endpoints;
  }
  return [
    lastSuccessfulEndpoint,
    ...endpoints.filter((endpoint) => endpoint !== lastSuccessfulEndpoint),
  ];
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs an operation against each configured endpoint until one succeeds.
 * Every failed endpoint is logged, and the endpoint that actually served a
 * successful request is logged as well. The last error is retained as the
 * cause of the aggregate error for callers and observability tools.
 */
export async function withSorobanRpcFailover<T>(
  operationName: string,
  operation: (endpoint: string) => Promise<T>,
  options: SorobanRpcOptions = {}
): Promise<T> {
  const endpoints = orderedEndpoints();
  const timeoutMs =
    options.timeoutMs ?? getSorobanRpcTimeoutMs(DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  let lastError: unknown;

  for (const endpoint of endpoints) {
    const remaining = options.totalTimeoutMs
      ? options.totalTimeoutMs - (Date.now() - startedAt)
      : timeoutMs;
    if (remaining <= 0) {
      lastError = new Error(`${operationName} exceeded its total timeout`);
      break;
    }
    const attemptTimeout = Math.min(timeoutMs, remaining);

    try {
      const result = await withTimeout(
        operation(endpoint),
        attemptTimeout,
        `${operationName} via ${formatSorobanRpcEndpoint(endpoint)}`
      );
      lastSuccessfulEndpoint = endpoint;
      console.info(
        `[Soroban RPC] ${operationName} served by ${formatSorobanRpcEndpoint(endpoint)}`
      );
      return result;
    } catch (error) {
      lastError = error;
      console.warn(
        `[Soroban RPC] ${operationName} failed via ${formatSorobanRpcEndpoint(endpoint)}: ${errorMessage(error)}`
      );
    }
  }

  const aggregate = new Error(
    `Soroban RPC ${operationName} failed on all configured endpoints (${endpoints.length})`
  );
  (aggregate as Error & { cause?: unknown }).cause = lastError;
  throw aggregate;
}

/**
 * JSON-RPC helper used by the event poller and health probe. It validates both
 * HTTP and JSON-RPC errors so a healthy-looking HTTP response cannot mask a
 * failed endpoint.
 */
export async function callSorobanRpc<T>(
  method: string,
  params: Record<string, unknown>,
  options: SorobanRpcOptions = {}
): Promise<T> {
  const timeoutMs =
    options.timeoutMs ?? getSorobanRpcTimeoutMs(DEFAULT_TIMEOUT_MS);

  return withSorobanRpcFailover(
    method,
    async (endpoint) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }

        const body = (await response.json()) as {
          result?: T;
          error?: { message?: string; code?: number };
        };

        if (body.error) {
          const detail = body.error.message || `code ${body.error.code ?? "unknown"}`;
          throw new Error(`JSON-RPC error: ${detail}`);
        }
        if (!("result" in body)) {
          throw new Error("JSON-RPC response did not include a result");
        }

        return body.result as T;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    { ...options, timeoutMs }
  );
}

/**
 * Runs an SDK operation against a freshly-created `rpc.Server`. The Stellar SDK
 * accepts a timeout option, while the outer failover timeout also protects
 * callers when a mocked or alternate SDK implementation ignores that option.
 */
export async function withSorobanRpcServer<T>(
  operationName: string,
  operation: (server: rpc.Server) => Promise<T>,
  options: SorobanRpcOptions = {}
): Promise<T> {
  const timeoutMs =
    options.timeoutMs ?? getSorobanRpcTimeoutMs(DEFAULT_TIMEOUT_MS);

  return withSorobanRpcFailover(
    operationName,
    async (endpoint) => {
      const server = new rpc.Server(endpoint, {
        timeout: timeoutMs,
        allowHttp: /^http:\/\//i.test(endpoint) && process.env.NODE_ENV !== "production",
      });
      return withTimeout(
        operation(server),
        timeoutMs,
        `${operationName} via ${formatSorobanRpcEndpoint(endpoint)}`
      );
    },
    { ...options, timeoutMs }
  );
}
