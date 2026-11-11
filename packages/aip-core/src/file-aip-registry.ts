import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  AipProviderConfig,
  AipRegistryState,
  ChatSession,
} from "./types.js";
export interface FileAipRegistryOptions {
  filePath: string;
}
export function configRevision(config: AipProviderConfig | null): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
export class FileAipRegistry {
  readonly #filePath: string;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(options: FileAipRegistryOptions) {
    this.#filePath = options.filePath;
  }
  async #readState(): Promise<AipRegistryState> {
    try {
      const state = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as AipRegistryState;
      if (!state || !state.sessions || !Object.hasOwn(state, "config"))
        throw new Error("Invalid AI registry");
      return state;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { config: null, sessions: {} };
      throw new Error("AI registry could not be loaded");
    }
  }
  #mutate<T>(fn: (state: AipRegistryState) => T): Promise<T> {
    const next = this.#queue.then(async () => {
      const state = await this.#readState();
      const result = fn(state);
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.#filePath}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(tmp, this.#filePath);
      return result;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
  async getConfig(): Promise<AipProviderConfig | null> {
    return (await this.#readState()).config;
  }
  async setConfig(
    config: AipProviderConfig,
    expectedRevision?: string,
  ): Promise<void> {
    return this.#mutate((state) => {
      if (
        expectedRevision !== undefined &&
        configRevision(state.config) !== expectedRevision
      )
        throw new Error("CONFIG_CONFLICT");
      state.config = config;
    });
  }
  async createSession(
    title: string,
    owner?: { userId: string; tenantId: string },
  ): Promise<ChatSession> {
    return this.#mutate((state) => {
      const now = new Date().toISOString();
      const session: ChatSession = {
        id: randomUUID(),
        title,
        messages: [],
        createdAt: now,
        updatedAt: now,
        ...owner,
      };
      state.sessions[session.id] = session;
      return session;
    });
  }
  async getSession(id: string): Promise<ChatSession | null> {
    return (await this.#readState()).sessions[id] ?? null;
  }
  async listSessions(): Promise<ChatSession[]> {
    return Object.values((await this.#readState()).sessions).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async appendMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<ChatSession> {
    return this.#mutate((state) => {
      const session = state.sessions[sessionId];
      if (!session) throw new Error("Session not found");
      session.messages.push({ role, content });
      session.updatedAt = new Date().toISOString();
      return session;
    });
  }
  async appendTurn(id: string, user: string, assistant: string): Promise<void> {
    return this.#mutate((state) => {
      const session = state.sessions[id];
      if (!session) throw new Error("Session not found");
      session.messages.push(
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      );
      session.updatedAt = new Date().toISOString();
    });
  }
  async deleteSession(id: string): Promise<void> {
    return this.#mutate((state) => {
      delete state.sessions[id];
    });
  }
}
