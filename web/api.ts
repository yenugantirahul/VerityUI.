export const apiRoot = '/api/v1';

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const result = await fetch(`${apiRoot}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (result.status === 204) return undefined as T;
  const payload = await result.json().catch(() => ({}));
  if (!result.ok)
    throw new Error(payload.error ?? 'The workspace API is unavailable');
  return payload as T;
}
