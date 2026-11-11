import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { AuthStore, AuthError } from "../src/auth-store.js";
import { installAuthentication } from "../src/routes/auth.js";
const input = {
  email: "owner@example.test",
  password: "a unique test passphrase 2026",
  displayName: "Owner",
  workspaceName: "Test company",
};
const headers = { "x-koiforge-request": "1", origin: "http://localhost:5173" };

test("authentication gates all API routes, ignores identity headers, revokes cookies and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-auth-"));
  const path = join(root, "auth.json");
  const app = Fastify();
  const store = new AuthStore(path);
  installAuthentication(app, store, ["http://localhost:5173"]);
  app.get("/api/private", async (request) => request.koiforgeSession);
  app.post("/api/private", async () => ({ ok: true }));
  try {
    assert.equal(
      (
        await app.inject({
          url: "/api/private",
          headers: { "x-koiforge-user-id": "admin" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          payload: input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers: { ...headers, origin: "https://untrusted.test" },
          payload: input,
        })
      ).statusCode,
      403,
    );
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers,
      payload: input,
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const token = cookie.split("=")[1]!;
    assert.match(String(setup.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
    assert(!setup.body.includes(input.password));
    assert.equal(setup.json().tenant.name, input.workspaceName);
    const identity = await app.inject({
      url: "/api/private",
      headers: {
        cookie,
        "x-koiforge-user-id": "admin",
        "x-koiforge-tenant-id": "platform",
      },
    });
    assert.equal(identity.json().tenant.id, "demo");
    assert.notEqual(identity.json().user.id, "admin");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/private",
          headers: { cookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers,
          payload: input,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers,
          payload: { ...input, password: "wrong" },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers,
      payload: input,
    });
    assert.equal(login.statusCode, 200);
    assert(await new AuthStore(path).authenticate(token));
    const raw = await readFile(path, "utf8");
    assert(!raw.includes(input.password));
    assert(!raw.includes(token));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { ...headers, cookie },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (await app.inject({ url: "/api/private", headers: { cookie } }))
        .statusCode,
      401,
    );
    assert.equal(await new AuthStore(path).authenticate(token), null);
    const state = JSON.parse(await readFile(path, "utf8"));
    state.sessions.forEach((s: { expires: number }) => {
      s.expires = 0;
    });
    await writeFile(path, JSON.stringify(state));
    const loginCookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.equal(
      (
        await app.inject({
          url: "/api/private",
          headers: { cookie: loginCookie },
        })
      ).statusCode,
      401,
    );
    await writeFile(path, "{broken");
    await assert.rejects(() => store.initialized());
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("bootstrap is serialized, passwords have a minimum, rate limits are bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-auth-"));
  const store = new AuthStore(join(root, "auth.json"));
  try {
    await assert.rejects(
      () => store.setup({ ...input, password: "short" }),
      AuthError,
    );
    const results = await Promise.allSettled([
      store.setup(input),
      store.setup(input),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    for (let i = 0; i < 10; i++) store.limit("127.0.0.1");
    assert.throws(
      () => store.limit("127.0.0.1"),
      (error: unknown) =>
        error instanceof AuthError && error.statusCode === 429,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production setup needs the operator token and issues a secure cookie', async () => {
  const previousMode = process.env.NODE_ENV; const previousToken = process.env.KOIFORGE_BOOTSTRAP_TOKEN;
  process.env.NODE_ENV = 'production'; process.env.KOIFORGE_BOOTSTRAP_TOKEN = 'fixture-operator-token-at-least-thirty-two-characters';
  const root = await mkdtemp(join(tmpdir(), 'koi-production-auth-')); const app = Fastify();
  installAuthentication(app, new AuthStore(join(root, 'auth.json')), ['https://workspace.example.test']);
  const productionHeaders = { 'x-koiforge-request': '1', origin: 'https://workspace.example.test' };
  try {
    const missing = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: productionHeaders, payload: input }); assert.equal(missing.statusCode, 403);
    const result = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: productionHeaders, payload: { ...input, setupToken: process.env.KOIFORGE_BOOTSTRAP_TOKEN } });
    assert.equal(result.statusCode, 200, result.body); assert.match(String(result.headers['set-cookie']), /; Secure/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...productionHeaders, origin: 'https://evil.test' }, payload: input })).statusCode, 403);
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousToken === undefined) delete process.env.KOIFORGE_BOOTSTRAP_TOKEN; else process.env.KOIFORGE_BOOTSTRAP_TOKEN = previousToken;
  }
});


test("OIDC platform admin is bound to issuer plus subject and receives owner permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-oidc-auth-"));
  const store = new AuthStore(join(root, "auth.json"));
  try {
    await store.setup(input);
    const first = await store.loginOidc({
      issuer: "https://login.example.org/realms/neurofunken",
      subject: "stable-subject",
      email: "admin@example.org",
      displayName: "Alex",
    });
    assert.deepEqual(first.session.roleIds, ["platform_admin"]);
    assert(first.session.permissions.includes("security.manage"));
    assert(first.session.permissions.includes("config.manage"));

    const second = await store.loginOidc({
      issuer: "https://login.example.org/realms/neurofunken",
      subject: "stable-subject",
      email: "admin@example.org",
      displayName: "Alex Example",
    });
    assert.equal(second.session.user.id, first.session.user.id);
    assert.equal(second.session.user.displayName, "Alex Example");

    await assert.rejects(() => store.loginOidc({
      issuer: "https://other.example.test/realms/neurofunken",
      subject: "different-subject",
      email: "admin@example.org",
      displayName: "Wrong issuer",
    }), (error: unknown) => error instanceof AuthError && error.statusCode === 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
