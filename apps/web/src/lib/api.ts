class BackendError extends Error {
  readonly errorType: string | null;
  readonly status: number;

  constructor(message: string, errorType: string | null, status: number) {
    super(message);
    this.name = 'BackendError';
    this.errorType = errorType;
    this.status = status;
  }
}

function getBackendErrorType(error: unknown): string | null {
  return error instanceof BackendError ? error.errorType : null;
}

function getBackendErrorStatus(error: unknown): number | null {
  return error instanceof BackendError ? error.status : null;
}

function extractErrorMessage(payloadText: string, status: number): { message: string; type: string | null } {
  if (!payloadText) return { message: `HTTP ${status}`, type: null };
  const MAX_MESSAGE_CHARS = 500;
  const truncate = (s: string): string => (s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…` : s);
  try {
    const data = JSON.parse(payloadText) as {
      Exception?: { Type?: string; Message?: string };
      error?: string;
      message?: string;
    };
    const type =
      typeof data?.Exception?.Type === 'string' && data.Exception.Type.length > 0
        ? data.Exception.Type
        : // Legacy `{error, message}` shape. The type used to be read only
          // from `Exception.Type`, so a legacy error body produced a correct
          // message but a `null` type — which sent it through the generic
          // fallback and lost the specific localized wording.
          typeof data?.error === 'string' && data.error.length > 0
          ? data.error
          : null;
    // AWS envelope first, then legacy `{error,message}`, then raw text.
    const exceptionMessage = data?.Exception?.Message;
    if (typeof exceptionMessage === 'string' && exceptionMessage.length > 0) return { message: truncate(exceptionMessage), type };
    const legacy = data?.message ?? data?.error;
    if (typeof legacy === 'string' && legacy.length > 0) return { message: truncate(legacy), type };
    if (type) return { message: `${type} (HTTP ${status})`, type };
  } catch {
    // Plain-text body: surface truncated as-is so an Access-login HTML page
    // cannot become an unbounded error string.
  }
  return { message: truncate(payloadText) || `HTTP ${status}`, type: null };
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    const { message, type } = extractErrorMessage(text, response.status);
    throw new BackendError(message, type, response.status);
  }
  // A 204 — or an empty body from an edge error page — has no JSON to parse.
  // `response.json()` threw `SyntaxError: Unexpected end of JSON input`, and
  // because that is not a `BackendError` the caller reported a generic failure
  // for an operation that had actually succeeded (e.g. credential revoke).
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text.trim() === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackendError(`HTTP ${response.status}: response body was not JSON`, null, response.status);
  }
}

export async function readDav(response: Response): Promise<string> {
  if (!response.ok && response.status !== 207) {
    const text = await response.text().catch(() => '');
    const { message, type } = extractErrorMessage(text, response.status);
    throw new BackendError(message, type, response.status);
  }
  return response.text();
}

function buildQuery(params: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) p.append(key, v);
    } else {
      p.set(key, value);
    }
  }
  return p.toString();
}

export async function apiGet<T>(path: string, params?: Record<string, string | string[] | undefined>): Promise<T> {
  const qs = params ? buildQuery(params) : '';
  return readJson<T>(await fetch(qs ? `${path}?${qs}` : path));
}

export async function apiPost<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function apiDelete<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { method: 'DELETE' }));
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiPost<T>(path, body, 'PATCH');
}

export { BackendError, extractErrorMessage, getBackendErrorStatus, getBackendErrorType };
