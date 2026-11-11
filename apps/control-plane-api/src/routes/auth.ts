import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthStore, AuthError } from "../auth-store.js";
import { OidcError, OidcLoginService, oidcConfigFromEnv } from "../auth/oidc.js";

const COOKIE = "koiforge_session";
const OIDC_BROWSER_COOKIE = "koiforge_oidc_browser";
const readerGetRoutes = new Set([
  "/api/auth/session",
  "/api/projects",
  "/api/projects/:id",
  "/api/object-workspace/families",
  "/api/object-workspace/families/:familyId/objects",
  "/api/object-workspace/families/:familyId/objects/:objectId",
  "/api/object-workspace/families/:familyId/objects/:objectId/links/:relationshipId",
]);

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const values = (request.headers.cookie ?? "").split(";").map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}

export function sessionCookie(request: FastifyRequest): string | undefined {
  return cookieValue(request, COOKIE);
}

export function authOrigins(): string[] {
  const value = process.env.KOIFORGE_PUBLIC_ORIGIN;
  if (process.env.NODE_ENV === "production" && (!value || new URL(value).protocol !== "https:"))
    throw new Error("KOIFORGE_PUBLIC_ORIGIN must be an HTTPS origin in production");
  if (value && new URL(value).origin !== value)
    throw new Error("KOIFORGE_PUBLIC_ORIGIN must contain an origin only");
  return value ? [value] : ["http://localhost:5173", "http://127.0.0.1:5173"];
}

function decodedPath(url: string): string {
  const raw = url.split("?")[0]!;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function matchedRoute(request: FastifyRequest): string {
  const candidate = (request.routeOptions as { url?: string }).url;
  return typeof candidate === "string" && candidate ? candidate : decodedPath(request.url);
}

function isPublicRoute(method: string, route: string): boolean {
  return ((method === "GET" || method === "HEAD") &&
      ["/api/auth/status", "/api/auth/oidc/start", "/api/auth/oidc/callback"].includes(route)) ||
    method === "POST" && ["/api/auth/login", "/api/auth/setup", "/api/auth/join"].includes(route);
}

function readerRouteAllowed(method: string, route: string): boolean {
  return ((method === "GET" || method === "HEAD") && readerGetRoutes.has(route)) ||
    method === "POST" && route === "/api/auth/logout";
}

async function authFailure(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>): Promise<unknown> {
  try { return await action(); }
  catch (error) {
    if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.message });
    request.log.error({ err: error instanceof Error ? error.name : "Error" }, "Authentication unavailable");
    return reply.code(503).send({ error: "Anmeldung derzeit nicht verfügbar." });
  }
}

export function installAuthentication(app: FastifyInstance, store: AuthStore, origins: string[]): void {
  const oidcConfig = oidcConfigFromEnv(process.env.KOIFORGE_PUBLIC_ORIGIN);
  const oidc = oidcConfig ? new OidcLoginService(oidcConfig) : null;
  app.decorateRequest("koiforgeSession");
  app.addHook("onRequest", async (request, reply) => {
    const rawPath = request.url.split("?")[0]!;
    const decoded = decodedPath(request.url);
    const route = matchedRoute(request);
    const apiRequest = rawPath.startsWith("/api/") || decoded.startsWith("/api/") || route.startsWith("/api/");
    if (!apiRequest || request.method === "OPTIONS") return;
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin && !origins.includes(origin))
      return reply.code(403).send({ error: "Dieser Ursprung ist nicht freigegeben." });
    if (!["GET", "HEAD"].includes(request.method) && request.headers["x-koiforge-request"] !== "1")
      return reply.code(403).send({ error: "Ungültige Anfrage." });
    if (isPublicRoute(request.method, route)) return;
    let session;
    try { session = await store.authenticate(sessionCookie(request)); }
    catch (error) {
      request.log.error({ err: error instanceof Error ? error.name : "Error" }, "Authentication unavailable");
      return reply.code(503).send({ error: "Anmeldung derzeit nicht verfügbar." });
    }
    if (!session) return reply.code(401).send({ error: "Bitte anmelden." });
    // OIDC admins have the same established permissions as local owners.
    // Route-specific guards still enforce each operation's permissions below.
    const administrator = session.roleIds.some(role => role === "owner" || role === "platform_admin");
    if (!administrator && !readerRouteAllowed(request.method, route))
      return reply.code(403).send({ error: "Für diese Anfrage fehlt die Berechtigung." });
    request.koiforgeSession = session;
  });

  const local = (request: FastifyRequest) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);
  const bootstrapToken = process.env.KOIFORGE_BOOTSTRAP_TOKEN;
  const setupAllowed = (request: FastifyRequest) => Boolean(bootstrapToken && bootstrapToken.length >= 32) ||
    (process.env.NODE_ENV !== "production" && local(request));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const cookie = (token: string, maxAge: number) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const oidcCookie = (token: string, maxAge: number) =>
    `${OIDC_BROWSER_COOKIE}=${token}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;

  app.get("/api/auth/status", (request, reply) => authFailure(request, reply, async () => ({
    initialized: await store.initialized(), setupAllowed: setupAllowed(request),
    tokenRequired: Boolean(bootstrapToken) || process.env.NODE_ENV === "production",
    sso: oidc ? { enabled: true, label: oidc.config.label, startPath: "/api/auth/oidc/start" } : { enabled: false },
  })));

  app.get<{ Querystring: { returnTo?: string } }>("/api/auth/oidc/start", (request, reply) =>
    authFailure(request, reply, async () => {
      if (!oidc) throw new AuthError("Single Sign-On ist nicht konfiguriert.", 404);
      store.limit(request.ip);
      const started = await oidc.start(request.query.returnTo);
      reply.header("Set-Cookie", oidcCookie(started.browserToken, 5 * 60));
      return reply.code(303).header("Location", started.authorizationUrl).send();
    }));

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/auth/oidc/callback", async (request, reply) => {
    const fallback = `${origins[0] ?? "/"}?sso_error=1#/monitoring`;
    reply.header("Set-Cookie", oidcCookie("", 0));
    if (!oidc || request.query.error || !request.query.code || !request.query.state)
      return reply.code(303).header("Location", fallback).send();
    try {
      const principal = await oidc.finish(
        request.query.code,
        request.query.state,
        cookieValue(request, OIDC_BROWSER_COOKIE),
      );
      const result = await store.loginOidc(principal);
      reply.header("Set-Cookie", [oidcCookie("", 0), cookie(result.token, SESSION_COOKIE_SECONDS)]);
      return reply.code(303).header("Location", `${origins[0] ?? "/"}/${principal.returnTo}`).send();
    } catch (error) {
      request.log.warn({ err: error instanceof OidcError ? error.name : "Error" }, "OIDC login rejected");
      return reply.code(303).header("Location", fallback).send();
    }
  });

  for (const mode of ["login", "setup"] as const)
    app.post<{ Body: Record<string, unknown> }>(`/api/auth/${mode}`, { bodyLimit: 8192 }, async (request, reply) =>
      authFailure(request, reply, async () => {
        store.limit(request.ip);
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthError("Ungültige Eingabe.");
        if (mode === "setup") {
          if (!setupAllowed(request)) throw new AuthError("Einrichtung ist nur durch den Betreiber möglich.", 403);
          if (bootstrapToken) {
            const candidate = typeof body.setupToken === "string" ? body.setupToken : "";
            if (Buffer.byteLength(candidate) !== Buffer.byteLength(bootstrapToken) ||
              !timingSafeEqual(Buffer.from(candidate), Buffer.from(bootstrapToken)))
              throw new AuthError("Einrichtungscode ist nicht korrekt.", 403);
          }
        }
        const result = await store[mode](body);
        reply.header("Set-Cookie", cookie(result.token, SESSION_COOKIE_SECONDS));
        return result.session;
      }));

  app.post<{ Body: Record<string, unknown> }>("/api/auth/join", { bodyLimit: 8192 }, async (request, reply) =>
    authFailure(request, reply, async () => {
      store.limit(request.ip);
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthError("Ungültige Einladung.");
      const result = await store.acceptInvitation(body as { token: string; password: string });
      reply.header("Set-Cookie", cookie(result.token, SESSION_COOKIE_SECONDS));
      return result.session;
    }));

  app.get("/api/auth/session", async (request) => request.koiforgeSession);
  app.post("/api/auth/logout", (request, reply) => authFailure(request, reply, async () => {
    await store.logout(sessionCookie(request));
    reply.header("Set-Cookie", cookie("", 0));
    return reply.code(204).send();
  }));

  app.get("/api/team", (request, reply) => authFailure(request, reply, async () => ({
    items: await store.listTeam(request.koiforgeSession),
  })));
  app.post<{ Body: { email: string; displayName: string } }>("/api/team/invites", { bodyLimit: 8192 }, (request, reply) =>
    authFailure(request, reply, () => store.invite(request.koiforgeSession, request.body)));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/team/:id/invitation", { bodyLimit: 1024 }, (request, reply) =>
    authFailure(request, reply, () => {
      if (request.body !== undefined &&
        (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length > 0))
        throw new AuthError("Ungültige Eingabe.");
      return store.renewInvitation(request.koiforgeSession, request.params.id);
    }));
  app.patch<{ Params: { id: string }; Body: { status: "active" | "disabled" } }>("/api/team/:id", { bodyLimit: 8192 }, (request, reply) =>
    authFailure(request, reply, async () => ({ member: await store.setMemberStatus(request.koiforgeSession, request.params.id, request.body) })));
}

const SESSION_COOKIE_SECONDS = 8 * 60 * 60;
