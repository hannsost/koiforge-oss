import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";

const MAX_REMOTE_BYTES = 256 * 1024;
const MAX_JWT_BYTES = 16 * 1024;
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_FLOWS = 1_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

interface OidcTokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
}

interface Jwks {
  keys?: Array<Record<string, unknown>>;
}

interface Flow {
  browserHash: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  expires: number;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  requiredRole: string;
  label: string;
  backchannelOrigin?: string;
}

export interface OidcStart {
  authorizationUrl: string;
  browserToken: string;
}

export interface OidcPrincipal {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  returnTo: string;
}

export class OidcError extends Error {
  constructor(message = "Single Sign-On ist fehlgeschlagen.") {
    super(message);
    this.name = "OidcError";
  }
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) throw new Error("KOIFORGE_PUBLIC_ORIGIN muss ein exakter HTTPS-Origin sein.");
  return value;
}

function exactIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    url.pathname.endsWith("/")
  ) throw new Error("KOIFORGE_OIDC_ISSUER muss ein exakter HTTPS-Issuer ohne abschließenden Slash sein.");
  return value;
}

function backchannelOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("KOIFORGE_OIDC_BACKCHANNEL_ORIGIN muss nur Origin und Port enthalten.");
  if (url.protocol === "http:" && !url.hostname.endsWith(".svc.cluster.local"))
    throw new Error("Unverschlüsselter OIDC-Backchannel ist nur zu einem Cluster-Service zulässig.");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("KOIFORGE_OIDC_BACKCHANNEL_ORIGIN muss HTTP(S) verwenden.");
  return url.origin;
}

export function oidcConfigFromEnv(publicOrigin: string | undefined): OidcConfig | null {
  const issuer = process.env.KOIFORGE_OIDC_ISSUER?.trim() ?? "";
  const clientId = process.env.KOIFORGE_OIDC_CLIENT_ID?.trim() ?? "";
  if (!issuer && !clientId) return null;
  if (!issuer || !clientId) throw new Error("KOIFORGE_OIDC_ISSUER und KOIFORGE_OIDC_CLIENT_ID müssen gemeinsam gesetzt sein.");
  if (!publicOrigin) throw new Error("KOIFORGE_PUBLIC_ORIGIN ist für OIDC erforderlich.");
  const origin = exactHttpsOrigin(publicOrigin);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId))
    throw new Error("KOIFORGE_OIDC_CLIENT_ID ist ungültig.");
  const requiredRole = process.env.KOIFORGE_OIDC_ADMIN_ROLE?.trim() || "platform-admin";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requiredRole))
    throw new Error("KOIFORGE_OIDC_ADMIN_ROLE ist ungültig.");
  return {
    issuer: exactIssuer(issuer),
    clientId,
    redirectUri: `${origin}/api/auth/oidc/callback`,
    postLogoutRedirectUri: `${origin}/`,
    requiredRole,
    label: process.env.KOIFORGE_OIDC_LABEL?.trim() || "NeuroFunken SSO",
    ...(process.env.KOIFORGE_OIDC_BACKCHANNEL_ORIGIN?.trim()
      ? { backchannelOrigin: backchannelOrigin(process.env.KOIFORGE_OIDC_BACKCHANNEL_ORIGIN.trim()) }
      : {}),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeReturnTo(value: string | undefined): string {
  if (!value) return "#/monitoring";
  if (value.length > 512 || !value.startsWith("#/") || /[\r\n]/.test(value)) return "#/monitoring";
  return value;
}

function sameOriginHttpsEndpoint(value: string, issuer: string): string {
  const endpoint = new URL(value);
  const issuerUrl = new URL(issuer);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== issuerUrl.origin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) throw new OidcError();
  return endpoint.toString();
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new OidcError();
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_REMOTE_BYTES) throw new OidcError();
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_REMOTE_BYTES) throw new OidcError();
  try { return JSON.parse(body) as T; } catch { throw new OidcError(); }
}

function decodePart<T>(part: string): T {
  if (part.length > MAX_JWT_BYTES) throw new OidcError();
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    throw new OidcError();
  }
}

function audienceIncludes(aud: string | string[] | undefined, clientId: string): boolean {
  return typeof aud === "string" ? aud === clientId : Array.isArray(aud) && aud.includes(clientId);
}

function verifyJwt(
  token: string,
  keys: Array<Record<string, unknown>>,
  config: OidcConfig,
  options: { nonce?: string; requiredRole?: string },
): JwtClaims {
  if (Buffer.byteLength(token) > MAX_JWT_BYTES) throw new OidcError();
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError();
  const header = decodePart<JwtHeader>(parts[0]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new OidcError();
  const candidates = keys.filter(key =>
    key.kid === header.kid &&
    key.kty === "RSA" &&
    (key.use === undefined || key.use === "sig") &&
    (key.alg === undefined || key.alg === "RS256"));
  if (candidates.length !== 1) throw new OidcError();
  let key;
  try {
    key = createPublicKey({ key: candidates[0], format: "jwk" } as Parameters<typeof createPublicKey>[0]);
  } catch {
    throw new OidcError();
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (typeof modulusLength === "number" && modulusLength < 2048) throw new OidcError();
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, "base64url");
  if (!verifySignature("RSA-SHA256", signed, key, signature)) throw new OidcError();

  const claims = decodePart<JwtClaims>(parts[1]!);
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== config.issuer ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !audienceIncludes(claims.aud, config.clientId) ||
    (claims.azp !== undefined && claims.azp !== config.clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now - 60 ||
    typeof claims.iat !== "number" ||
    claims.iat > now + 60 ||
    (typeof claims.nbf === "number" && claims.nbf > now + 60)
  ) throw new OidcError();
  if (options.nonce !== undefined && claims.nonce !== options.nonce) throw new OidcError();
  if (options.requiredRole) {
    const roles = claims.realm_access?.roles;
    if (!Array.isArray(roles) || !roles.includes(options.requiredRole)) throw new OidcError("Für diesen Zugang fehlt die Plattform-Admin-Rolle.");
  }
  return claims;
}

export class OidcLoginService {
  private readonly flows = new Map<string, Flow>();
  private discoveryCache?: { value: OidcDiscovery; expires: number };

  constructor(
    readonly config: OidcConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private pruneFlows(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) if (flow.expires <= now) this.flows.delete(state);
    if (this.flows.size >= MAX_FLOWS) throw new OidcError("Zu viele gleichzeitige SSO-Anmeldungen.");
  }

  private async request(url: string | URL, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: {
          accept: "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch {
      throw new OidcError();
    }
  }

  private backchannel(publicUrl: string): string {
    if (!this.config.backchannelOrigin) return publicUrl;
    const source = new URL(publicUrl);
    const target = new URL(this.config.backchannelOrigin);
    target.pathname = source.pathname;
    target.search = source.search;
    return target.toString();
  }

  private async discovery(): Promise<OidcDiscovery> {
    if (this.discoveryCache && this.discoveryCache.expires > Date.now()) return this.discoveryCache.value;
    const issuerUrl = new URL(this.config.issuer);
    const discoveryPublic = `${issuerUrl.origin}${issuerUrl.pathname}/.well-known/openid-configuration`;
    const response = await this.request(this.backchannel(discoveryPublic));
    const value = await json<OidcDiscovery>(response);
    if (
      value.issuer !== this.config.issuer ||
      typeof value.authorization_endpoint !== "string" ||
      typeof value.token_endpoint !== "string" ||
      typeof value.jwks_uri !== "string"
    ) throw new OidcError();
    const validated: OidcDiscovery = {
      issuer: value.issuer,
      authorization_endpoint: sameOriginHttpsEndpoint(value.authorization_endpoint, this.config.issuer),
      token_endpoint: sameOriginHttpsEndpoint(value.token_endpoint, this.config.issuer),
      jwks_uri: sameOriginHttpsEndpoint(value.jwks_uri, this.config.issuer),
      ...(typeof value.end_session_endpoint === "string"
        ? { end_session_endpoint: sameOriginHttpsEndpoint(value.end_session_endpoint, this.config.issuer) }
        : {}),
    };
    this.discoveryCache = { value: validated, expires: Date.now() + 5 * 60 * 1000 };
    return validated;
  }

  async start(returnToRaw?: string): Promise<OidcStart> {
    this.pruneFlows();
    const discovery = await this.discovery();
    const state = randomToken();
    const browserToken = randomToken();
    const verifier = randomToken(48);
    const nonce = randomToken();
    this.flows.set(state, {
      browserHash: sha256(browserToken),
      verifier,
      nonce,
      returnTo: safeReturnTo(returnToRaw),
      expires: Date.now() + FLOW_TTL_MS,
    });
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: url.toString(), browserToken };
  }

  async finish(code: string, state: string, browserToken: string | undefined): Promise<OidcPrincipal> {
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(state) || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code))
      throw new OidcError();
    const flow = this.flows.get(state);
    this.flows.delete(state);
    if (!flow || flow.expires <= Date.now() || !browserToken || sha256(browserToken) !== flow.browserHash)
      throw new OidcError();

    const discovery = await this.discovery();
    const tokenResponse = await this.request(this.backchannel(discovery.token_endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code_verifier: flow.verifier,
      }).toString(),
    });
    const tokens = await json<OidcTokenResponse>(tokenResponse);
    if (
      tokens.token_type?.toLowerCase() !== "bearer" ||
      typeof tokens.id_token !== "string" ||
      typeof tokens.access_token !== "string"
    ) throw new OidcError();

    const jwks = await json<Jwks>(await this.request(this.backchannel(discovery.jwks_uri)));
    if (!Array.isArray(jwks.keys)) throw new OidcError();
    const identity = verifyJwt(tokens.id_token, jwks.keys, this.config, { nonce: flow.nonce });
    const access = verifyJwt(tokens.access_token, jwks.keys, this.config, { requiredRole: this.config.requiredRole });
    if (identity.sub !== access.sub) throw new OidcError();
    const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OidcError();
    const displayName = [identity.name, identity.preferred_username, email]
      .find(value => typeof value === "string" && value.trim())!.trim().slice(0, 100);
    return {
      issuer: this.config.issuer,
      subject: identity.sub!,
      email,
      displayName,
      returnTo: flow.returnTo,
    };
  }

  async logoutUrl(): Promise<string | null> {
    const discovery = await this.discovery();
    if (!discovery.end_session_endpoint) return null;
    const url = new URL(discovery.end_session_endpoint);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      post_logout_redirect_uri: this.config.postLogoutRedirectUri,
    }).toString();
    return url.toString();
  }
}
