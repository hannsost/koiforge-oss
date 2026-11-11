/** Same-origin by default; deployment proxies /api to its dedicated API instance. */
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  notify = true,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-koiforge-request", "1");
  const response = await fetch(input, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 401 && notify)
    window.dispatchEvent(new Event("koiforge:unauthorized"));
  return response;
}
export async function authRequest<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await authenticatedFetch(
    `${apiBaseUrl}/api/auth/${path}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
    false,
  );
  if (path === "logout" && response.status === 401) return undefined as T;
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      data.error ??
        "Der Dienst ist gerade nicht erreichbar. Bitte erneut versuchen.",
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
