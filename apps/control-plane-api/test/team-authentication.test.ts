import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { AuthError, AuthStore, ownerPermissions, projectReaderPermissions } from "../src/auth-store.js";
import { installAuthentication } from "../src/routes/auth.js";

const ownerInput = {
  email: "owner@example.test",
  password: "a unique owner passphrase 2026",
  displayName: "Owner",
  workspaceName: "Test company",
};
const readerPassword = "a reader passphrase for 2026";
const headers = { "x-koiforge-request": "1", origin: "http://localhost:5173" };

test("v1 stores remain byte-identical on reads, old cookies work, and the next mutation migrates to v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-team-v1-"));
  const path = join(root, "auth.json");
  try {
    const setup = await new AuthStore(path).setup(ownerInput);
    const v2 = JSON.parse(await readFile(path, "utf8"));
    const owner = v2.accounts[0];
    const legacy = {
      version: 1,
      workspace: v2.workspace,
      account: { id: owner.id, email: owner.email, displayName: owner.displayName, salt: owner.salt, digest: owner.digest },
      sessions: v2.sessions.map(({ hash, expires }: { hash: string; expires: number }) => ({ hash, expires })),
    };
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
    const before = await readFile(path, "utf8");
    const store = new AuthStore(path);
    assert.equal(await store.initialized(), true);
    assert.deepEqual((await store.authenticate(setup.token))?.user, setup.session.user);
    assert.deepEqual((await store.resolvePrincipal({ userId: setup.session.user.id, tenantId: "demo" }))?.roleIds, ["owner"]);
    assert.equal(await readFile(path, "utf8"), before, "read paths must not rewrite legacy state");

    const invitation = await store.invite(setup.session, { email: "reader@example.test", displayName: "Reader" });
    assert.equal(invitation.member.status, "invited");
    const migrated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.accounts[0].id, owner.id);
    assert.equal(migrated.sessions[0].hash, legacy.sessions[0].hash);
    assert.equal(migrated.sessions[0].userId, owner.id);
    assert.deepEqual(setup.session.permissions, ownerPermissions);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invitations rotate, activate once across store instances, support login, and disabling revokes access", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-team-lifecycle-"));
  const path = join(root, "auth.json");
  try {
    const first = new AuthStore(path); const second = new AuthStore(path);
    const setup = await first.setup(ownerInput);
    const original = await first.invite(setup.session, { email: "Reader@Example.Test", displayName: "Reader" });
    const rawAfterInvite = await readFile(path, "utf8");
    assert(!rawAfterInvite.includes(original.token));
    assert(!rawAfterInvite.includes(readerPassword));
    await assert.rejects(() => first.invite(setup.session, { email: "reader@example.test", displayName: "Duplicate" }),
      (error: unknown) => error instanceof AuthError && error.statusCode === 409);
    await assert.rejects(() => first.setMemberStatus(setup.session, original.member.id, { status: "active" }),
      (error: unknown) => error instanceof AuthError && error.statusCode === 409);

    const renewed = await second.renewInvitation(setup.session, original.member.id);
    assert.notEqual(renewed.token, original.token);
    await assert.rejects(() => first.acceptInvitation({ token: original.token, password: readerPassword }), AuthError);
    const races = await Promise.allSettled([
      first.acceptInvitation({ token: renewed.token, password: readerPassword }),
      second.acceptInvitation({ token: renewed.token, password: readerPassword }),
    ]);
    assert.equal(races.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(races.filter((result) => result.status === "rejected").length, 1);
    const accepted = races.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<AuthStore["acceptInvitation"]>>> => result.status === "fulfilled")!.value;
    assert.deepEqual(accepted.session.roleIds, ["project_reader"]);
    assert.deepEqual(accepted.session.permissions, projectReaderPermissions);
    assert.equal((await first.listTeam(setup.session))[0]?.status, "active");
    await assert.rejects(() => first.listTeam(accepted.session), (error: unknown) => error instanceof AuthError && error.statusCode === 403);
    const readerLogin = await first.login({ email: "reader@example.test", password: readerPassword });
    assert.equal(readerLogin.session.user.id, original.member.id);

    await first.setMemberStatus(setup.session, original.member.id, { status: "disabled" });
    assert.equal(await second.authenticate(accepted.token), null);
    assert.equal(await second.authenticate(readerLogin.token), null);
    assert.equal(await second.resolvePrincipal({ userId: original.member.id, tenantId: "demo" }), null);
    await assert.rejects(() => second.login({ email: "reader@example.test", password: readerPassword }),
      (error: unknown) => error instanceof AuthError && error.statusCode === 401);
    await second.setMemberStatus(setup.session, original.member.id, { status: "active" });
    assert.equal((await new AuthStore(path).login({ email: "reader@example.test", password: readerPassword })).session.user.id, original.member.id);

    const expiring = await first.invite(setup.session, { email: "expired@example.test", displayName: "Expired" });
    const state = JSON.parse(await readFile(path, "utf8"));
    state.accounts.find((account: { id: string }) => account.id === expiring.member.id).invitation.expires = 1;
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(() => second.acceptInvitation({ token: expiring.token, password: readerPassword }), AuthError);

    const persisted = await readFile(path, "utf8");
    assert(!persisted.includes(original.token)); assert(!persisted.includes(renewed.token)); assert(!persisted.includes(readerPassword));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reader HTTP access uses canonical route templates and defaults every other API route to forbidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-team-http-")); const path = join(root, "auth.json");
  const app = Fastify(); const store = new AuthStore(path);
  installAuthentication(app, store, ["http://localhost:5173"]);
  app.get("/api/projects", async (request) => ({ user: request.koiforgeSession.user.id }));
  app.post("/api/projects", async () => ({ changed: true }));
  app.get("/api/projects/:id", async () => ({ project: true }));
  app.get("/api/object-workspace/families", async () => ({ items: [] }));
  app.get("/api/datasets", async () => ({ secret: true }));
  app.get("/api/legacy/:id", async () => ({ secret: true }));
  try {
    const owner = await store.setup(ownerInput);
    const invitation = await store.invite(owner.session, { email: "reader@example.test", displayName: "Reader" });
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/join", payload: { token: invitation.token, password: readerPassword } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/join", headers: { ...headers, origin: "https://evil.test" }, payload: { token: invitation.token, password: readerPassword } })).statusCode, 403);
    const joined = await app.inject({ method: "POST", url: "/api/auth/join", headers, payload: { token: invitation.token, password: readerPassword } });
    assert.equal(joined.statusCode, 200, joined.body);
    const readerCookie = String(joined.headers["set-cookie"]).split(";")[0]!;
    assert.match(String(joined.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
    assert.deepEqual(joined.json().permissions, projectReaderPermissions);
    assert.equal((await app.inject({ url: "/api/projects", headers: { cookie: readerCookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/projects/${crypto.randomUUID()}`, headers: { cookie: readerCookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/ap%69/projects", headers: { cookie: readerCookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "HEAD", url: "/api/object-workspace/families", headers: { cookie: readerCookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/datasets", headers: { cookie: readerCookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: "HEAD", url: "/api/datasets", headers: { cookie: readerCookie } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/ap%69/legacy/one", headers: { cookie: readerCookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers: { ...headers, cookie: readerCookie } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/team", headers: { cookie: readerCookie } })).statusCode, 403);

    const ownerCookie = `koiforge_session=${owner.token}`;
    assert.equal((await app.inject({ url: "/api/datasets", headers: { cookie: ownerCookie } })).statusCode, 200);
    const member = (await store.listTeam(owner.session))[0]!;
    assert.equal((await app.inject({ method: "POST", url: `/api/team/${member.id}/invitation`, headers: { ...headers, cookie: ownerCookie }, payload: { extra: true } })).statusCode, 400);

    await writeFile(path, "{broken", { mode: 0o600 });
    const failed = await app.inject({ url: "/api/projects", headers: { cookie: readerCookie } });
    assert.equal(failed.statusCode, 503); assert.deepEqual(failed.json(), { error: "Anmeldung derzeit nicht verfügbar." });
    const status = await app.inject({ url: "/api/auth/status" });
    assert.equal(status.statusCode, 503); assert.deepEqual(status.json(), { error: "Anmeldung derzeit nicht verfügbar." });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("strict v2 validation rejects duplicate hashes, sessions for disabled users, and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-team-corrupt-")); const path = join(root, "auth.json");
  try {
    const store = new AuthStore(path); await store.setup(ownerInput);
    const original = JSON.parse(await readFile(path, "utf8"));
    original.sessions.push({ ...original.sessions[0] });
    await writeFile(path, JSON.stringify(original), { mode: 0o600 });
    await assert.rejects(() => new AuthStore(path).initialized(), /Invalid authentication store/);
    await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(() => new AuthStore(path).initialized(), /Invalid authentication store/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
