import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";

import { OidcError, OidcLoginService, type OidcConfig } from "../src/auth/oidc.js";

const config: OidcConfig = {
  issuer: "https://login.example.test/realms/neurofunken",
  clientId: "koiforge",
  redirectUri: "https://koiforge.example.test/api/auth/oidc/callback",
  postLogoutRedirectUri: "https://koiforge.example.test/",
  requiredRole: "platform-admin",
  label: "NeuroFunken SSO",
};

function jwt(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], kid: string, claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const body = `${header}.${payload}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

function fixture(options: { roles?: string[]; audience?: string } = {}) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "fixture-key";
  const jwk = keys.publicKey.export({ format: "jwk" }) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  jwk.kid = kid; jwk.alg = "RS256"; jwk.use = "sig";
  let nonce = "";
  let challenge = "";
  let verifierSeen = "";
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: config.issuer,
        authorization_endpoint: `${new URL(config.issuer).origin}/realms/neurofunken/protocol/openid-connect/auth`,
        token_endpoint: `${new URL(config.issuer).origin}/realms/neurofunken/protocol/openid-connect/token`,
        jwks_uri: `${new URL(config.issuer).origin}/realms/neurofunken/protocol/openid-connect/certs`,
        end_session_endpoint: `${new URL(config.issuer).origin}/realms/neurofunken/protocol/openid-connect/logout`,
      });
    }
    if (url.pathname.endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      verifierSeen = body.get("code_verifier") ?? "";
      const aud = options.audience ?? config.clientId;
      const identity = jwt(keys.privateKey, kid, {
        iss: config.issuer, sub: "user-123", aud, azp: config.clientId,
        exp: now + 300, iat: now, nonce,
        email: "admin@example.org", name: "Alex",
      });
      const access = jwt(keys.privateKey, kid, {
        iss: config.issuer, sub: "user-123", aud, azp: config.clientId,
        exp: now + 300, iat: now,
        realm_access: { roles: options.roles ?? ["platform-admin"] },
      });
      return Response.json({ access_token: access, id_token: identity, token_type: "Bearer" });
    }
    if (url.pathname.endsWith("/certs")) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected URL ${url}`);
  };
  return {
    service: new OidcLoginService(config, fetchImpl),
    captureAuthorization(url: string) {
      const parsed = new URL(url);
      nonce = parsed.searchParams.get("nonce") ?? "";
      challenge = parsed.searchParams.get("code_challenge") ?? "";
      return parsed.searchParams.get("state") ?? "";
    },
    verifierValid() {
      return createHash("sha256").update(verifierSeen).digest("base64url") === challenge;
    },
  };
}

test("OIDC login uses PKCE, state/browser binding, nonce, audience and platform-admin role", async () => {
  const f = fixture();
  const started = await f.service.start("#/monitoring");
  const state = f.captureAuthorization(started.authorizationUrl);
  const principal = await f.service.finish("authorization-code", state, started.browserToken);
  assert.equal(principal.email, "admin@example.org");
  assert.equal(principal.returnTo, "#/monitoring");
  assert.equal(f.verifierValid(), true);
  await assert.rejects(
    f.service.finish("authorization-code", state, started.browserToken),
    OidcError,
    "flow is consumed exactly once",
  );
});

test("OIDC login rejects wrong browser binding and missing platform-admin role", async () => {
  const bound = fixture();
  const started = await bound.service.start("#/monitoring");
  const state = bound.captureAuthorization(started.authorizationUrl);
  await assert.rejects(bound.service.finish("authorization-code", state, "wrong-browser-proof"), OidcError);

  const unprivileged = fixture({ roles: ["user"] });
  const second = await unprivileged.service.start("#/monitoring");
  const secondState = unprivileged.captureAuthorization(second.authorizationUrl);
  await assert.rejects(
    unprivileged.service.finish("authorization-code", secondState, second.browserToken),
    /Plattform-Admin-Rolle/,
  );
});

test("OIDC login rejects a token issued for another audience", async () => {
  const f = fixture({ audience: "other-client" });
  const started = await f.service.start("#/monitoring");
  const state = f.captureAuthorization(started.authorizationUrl);
  await assert.rejects(f.service.finish("authorization-code", state, started.browserToken), OidcError);
});
