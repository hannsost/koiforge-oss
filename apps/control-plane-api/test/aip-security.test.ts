import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import Fastify from "fastify";
import { FileAipRegistry } from "@koiforge/aip-core";
import { FileSecurityRegistry } from "@koiforge/security-core";
import { registerAipRoutes } from "../src/routes/aip.js";
import { ownerPermissions } from "../src/auth-store.js";
import type { AppRegistries } from "../src/registries.js";

test("AI configuration redacts credentials, checks revisions, and chat enforces ownership with atomic turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "koi-ai-auth-"));
  let fails = false;
  let calls = 0;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume fixture data */
    }
    calls++;
    response.writeHead(fails ? 500 : 200, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify(
        fails
          ? { error: "SECRET-KEY-DO-NOT-LEAK" }
          : { choices: [{ message: { content: "Belegte Testantwort" } }] },
      ),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  process.env.KOIFORGE_AI_BASE_URLS = baseUrl;
  const aip = new FileAipRegistry({ filePath: join(root, "aip.json") });
  const security = new FileSecurityRegistry({
    filePath: join(root, "security.json"),
  });
  let user = "owner";
  let permissions = ownerPermissions;
  const app = Fastify();
  // Explicit trusted identity fixture. Production has only the verified cookie hook.
  app.addHook("onRequest", async (request) => {
    request.koiforgeSession = {
      user: { id: user, displayName: user },
      tenant: {
        id: "company",
        name: "Company",
        slug: "company",
        status: "active",
      },
      roleIds: ["owner"],
      permissions,
    };
  });
  registerAipRoutes(app, { aip, security } as AppRegistries);
  try {
    const initial = (await app.inject("/api/aip/config")).json();
    const config = {
      provider: "custom",
      baseUrl,
      model: "fixture",
      apiKey: "SECRET-KEY-DO-NOT-LEAK",
      revision: initial.revision,
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/aip/config",
      payload: config,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert(!saved.body.includes(config.apiKey));
    assert(saved.json().config.hasKey);
    assert(!(await app.inject("/api/aip/config")).body.includes(config.apiKey));
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/aip/config",
          payload: config,
        })
      ).statusCode,
      409,
    );
    const preserved = await app.inject({
      method: "PUT",
      url: "/api/aip/config",
      payload: {
        ...config,
        apiKey: "",
        model: "fixture-2",
        revision: saved.json().revision,
      },
    });
    assert.equal(preserved.statusCode, 200);
    assert.equal((await aip.getConfig())?.apiKey, config.apiKey);
    permissions = ["modules.read"];
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/aip/config",
          payload: config,
        })
      ).statusCode,
      403,
    );
    permissions = ownerPermissions;
    const answer = await app.inject({
      method: "POST",
      url: "/api/aip/chat",
      payload: { message: "Hallo" },
    });
    assert.equal(answer.statusCode, 200, answer.body);
    const id = answer.json().sessionId;
    user = "other";
    assert.equal(
      (await app.inject("/api/aip/sessions")).json().items.length,
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/aip/chat",
          payload: { sessionId: id, message: "Read private chat" },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/aip/sessions/${id}` }))
        .statusCode,
      404,
    );
    assert.equal(calls, 1);
    user = "owner";
    fails = true;
    const failed = await app.inject({
      method: "POST",
      url: "/api/aip/chat",
      payload: { sessionId: id, message: "Retryable draft" },
    });
    assert.equal(failed.statusCode, 502);
    assert(!failed.body.includes(config.apiKey));
    assert.equal((await aip.getSession(id))?.messages.length, 2);
    assert.equal((await stat(join(root, "aip.json"))).mode & 0o777, 0o600);
    await app.inject({ method: "DELETE", url: `/api/aip/sessions/${id}` });
    assert(!(await readFile(join(root, "aip.json"), "utf8")).includes("Hallo"));
    const legacy = await aip.createSession("legacy without owner");
    assert(!(await app.inject("/api/aip/sessions")).body.includes(legacy.id));
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    delete process.env.KOIFORGE_AI_BASE_URLS;
    await rm(root, { recursive: true, force: true });
  }
});
