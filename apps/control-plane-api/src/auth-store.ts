import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionContext } from "@koiforge/security-core";

const SESSION_MS = 8 * 60 * 60 * 1000;
const INVITATION_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS = 1_000;
const MAX_SESSIONS_PER_ACCOUNT = 20;
const MAX_SESSIONS = MAX_ACCOUNTS * MAX_SESSIONS_PER_ACCOUNT;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const mutationQueues = new Map<string, Promise<unknown>>();

export const ownerPermissions = [
  "modules.read", "modules.manage", "datasets.read", "datasets.manage", "datasets.snapshot",
  "cases.read", "cases.manage", "views.read", "views.manage", "audit.read",
  "config.read", "config.manage", "secrets.read", "secrets.manage", "security.read", "security.manage",
  "projects.read", "projects.manage", "objects.read", "team.manage",
];
export const projectReaderPermissions = ["projects.read", "objects.read"];

export interface TeamMember {
  id: string;
  email: string;
  displayName: string;
  status: "invited" | "active" | "disabled";
}
interface LegacyAccount { id: string; email: string; displayName: string; salt: string; digest: string }
interface Invitation { hash: string; expires: number }
interface Account {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "platform_admin" | "project_reader";
  status: "invited" | "active" | "disabled";
  salt?: string;
  digest?: string;
  oidcIssuer?: string;
  oidcSubject?: string;
  invitation?: Invitation;
}
interface State {
  version: 2;
  workspace: { id: string; name: string };
  accounts: Account[];
  sessions: Array<{ hash: string; userId: string; expires: number }>;
}

export class AuthError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function derive(password: string, saltValue: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, saltValue, 64,
    { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
    (err, key) => (err ? reject(err) : resolve(key))));
}
function text(value: unknown, max: number): string {
  return typeof value === "string" && value.trim().length <= max ? value.trim() : "";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{128}$/;
const saltPattern = /^[a-f0-9]{32}$/;
const tokenHashPattern = /^[a-f0-9]{64}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
}

function parseState(value: unknown): State {
  if (!record(value)) throw new Error("Invalid authentication store");
  if (value.version === 1) {
    if (!exactKeys(value, ["version", "workspace", "account", "sessions"])) throw new Error("Invalid authentication store");
    const workspace = value.workspace; const account = value.account; const sessions = value.sessions;
    if (!record(workspace) || !exactKeys(workspace, ["id", "name"]) ||
      !validShortString(workspace.id, 100) || !validShortString(workspace.name, 100) ||
      !record(account) || !exactKeys(account, ["id", "email", "displayName", "salt", "digest"]) ||
      typeof account.id !== "string" || !uuid.test(account.id) || !validShortString(account.email, 254) || !emailPattern.test(account.email) ||
      !validShortString(account.displayName, 100) || typeof account.salt !== "string" || !saltPattern.test(account.salt) ||
      typeof account.digest !== "string" || !digestPattern.test(account.digest) ||
      !Array.isArray(sessions) || sessions.length > MAX_SESSIONS_PER_ACCOUNT) throw new Error("Invalid authentication store");
    const parsedSessions = sessions.map((entry) => {
      if (!record(entry) || !exactKeys(entry, ["hash", "expires"]) || typeof entry.hash !== "string" ||
        !tokenHashPattern.test(entry.hash) || typeof entry.expires !== "number" || !Number.isSafeInteger(entry.expires) || entry.expires < 0)
        throw new Error("Invalid authentication store");
      return { hash: entry.hash, userId: account.id as string, expires: entry.expires };
    });
    return {
      version: 2,
      workspace: { id: workspace.id, name: workspace.name },
      accounts: [{ id: account.id, email: account.email.toLowerCase(), displayName: account.displayName,
        role: "owner", status: "active", salt: account.salt, digest: account.digest }],
      sessions: parsedSessions,
    };
  }
  if (value.version !== 2 || !exactKeys(value, ["version", "workspace", "accounts", "sessions"]) ||
    !record(value.workspace) || !exactKeys(value.workspace, ["id", "name"]) ||
    !validShortString(value.workspace.id, 100) || !validShortString(value.workspace.name, 100) ||
    !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > MAX_ACCOUNTS ||
    !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) throw new Error("Invalid authentication store");
  const ids = new Set<string>(); const emails = new Set<string>(); const invitationHashes = new Set<string>();
  const oidcIdentities = new Set<string>(); let owners = 0;
  const accounts = value.accounts.map((entry): Account => {
    if (!record(entry)) throw new Error("Invalid authentication store");
    const allowed = ["id", "email", "displayName", "role", "status", "salt", "digest", "oidcIssuer", "oidcSubject", "invitation"];
    if (Object.keys(entry).some((key) => !allowed.includes(key)) ||
      typeof entry.id !== "string" || !uuid.test(entry.id) || ids.has(entry.id) ||
      !validShortString(entry.email, 254) || !emailPattern.test(entry.email) || entry.email !== entry.email.toLowerCase() || emails.has(entry.email) ||
      !validShortString(entry.displayName, 100) || !["owner", "platform_admin", "project_reader"].includes(String(entry.role)) ||
      !["invited", "active", "disabled"].includes(String(entry.status))) throw new Error("Invalid authentication store");
    ids.add(entry.id); emails.add(entry.email); if (entry.role === "owner") owners++;
    const hasCredentials = typeof entry.salt === "string" && saltPattern.test(entry.salt) &&
      typeof entry.digest === "string" && digestPattern.test(entry.digest);
    const hasNoCredentials = entry.salt === undefined && entry.digest === undefined;
    if (!hasCredentials && !hasNoCredentials) throw new Error("Invalid authentication store");
    const hasOidc = typeof entry.oidcIssuer === "string" && typeof entry.oidcSubject === "string"
      && entry.oidcIssuer.length > 0 && entry.oidcIssuer.length <= 512
      && entry.oidcSubject.length > 0 && entry.oidcSubject.length <= 512;
    const hasNoOidc = entry.oidcIssuer === undefined && entry.oidcSubject === undefined;
    if (!hasOidc && !hasNoOidc) throw new Error("Invalid authentication store");
    if (hasOidc) {
      let issuer: URL;
      try { issuer = new URL(entry.oidcIssuer as string); } catch { throw new Error("Invalid authentication store"); }
      if (issuer.protocol !== "https:" || issuer.search || issuer.hash || issuer.username || issuer.password)
        throw new Error("Invalid authentication store");
      const oidcIdentity = `${entry.oidcIssuer}\n${entry.oidcSubject}`;
      if (oidcIdentities.has(oidcIdentity)) throw new Error("Invalid authentication store");
      oidcIdentities.add(oidcIdentity);
    }
    let invitation: Invitation | undefined;
    if (entry.invitation !== undefined) {
      if (!record(entry.invitation) || !exactKeys(entry.invitation, ["hash", "expires"]) ||
        typeof entry.invitation.hash !== "string" || !tokenHashPattern.test(entry.invitation.hash) ||
        typeof entry.invitation.expires !== "number" || !Number.isSafeInteger(entry.invitation.expires) || entry.invitation.expires < 0)
        throw new Error("Invalid authentication store");
      invitation = { hash: entry.invitation.hash, expires: entry.invitation.expires };
      if (invitationHashes.has(invitation.hash)) throw new Error("Invalid authentication store");
      invitationHashes.add(invitation.hash);
    }
    if (entry.role === "owner" && (entry.status !== "active" || !hasCredentials || invitation)) throw new Error("Invalid authentication store");
    if (entry.role === "platform_admin" && (entry.status !== "active" || !hasOidc || invitation)) throw new Error("Invalid authentication store");
    if (entry.role === "project_reader" && hasOidc) throw new Error("Invalid authentication store");
    if (entry.status === "invited" && (hasCredentials || hasOidc || !invitation)) throw new Error("Invalid authentication store");
    if (entry.status === "active" && (!hasCredentials && !hasOidc || invitation)) throw new Error("Invalid authentication store");
    if (entry.status === "disabled" && (!hasCredentials && !hasOidc || invitation)) throw new Error("Invalid authentication store");
    return { id: entry.id, email: entry.email, displayName: entry.displayName,
      role: entry.role as Account["role"], status: entry.status as Account["status"],
      ...(hasCredentials ? { salt: entry.salt as string, digest: entry.digest as string } : {}),
      ...(hasOidc ? { oidcIssuer: entry.oidcIssuer as string, oidcSubject: entry.oidcSubject as string } : {}),
      ...(invitation ? { invitation } : {}) };
  });
  if (owners !== 1) throw new Error("Invalid authentication store");
  const sessionHashes = new Set<string>(); const sessionCounts = new Map<string, number>();
  const sessions = value.sessions.map((entry) => {
    if (!record(entry) || !exactKeys(entry, ["hash", "userId", "expires"]) || typeof entry.hash !== "string" ||
      !tokenHashPattern.test(entry.hash) || typeof entry.userId !== "string" || !ids.has(entry.userId) ||
      typeof entry.expires !== "number" || !Number.isSafeInteger(entry.expires) || entry.expires < 0)
      throw new Error("Invalid authentication store");
    if (sessionHashes.has(entry.hash)) throw new Error("Invalid authentication store");
    sessionHashes.add(entry.hash);
    const account = accounts.find((candidate) => candidate.id === entry.userId);
    const count = (sessionCounts.get(entry.userId) ?? 0) + 1;
    if (!account || account.status !== "active" || count > MAX_SESSIONS_PER_ACCOUNT)
      throw new Error("Invalid authentication store");
    sessionCounts.set(entry.userId, count);
    return { hash: entry.hash, userId: entry.userId, expires: entry.expires };
  });
  return { version: 2, workspace: { id: value.workspace.id, name: value.workspace.name }, accounts, sessions };
}
function teamMember(account: Account): TeamMember {
  return { id: account.id, email: account.email, displayName: account.displayName, status: account.status };
}

/** One company per deployment until all legacy data registries support tenant isolation. */
export class AuthStore {
  private attempts = new Map<string, { count: number; until: number }>();
  private readonly queueKey: string;
  constructor(private readonly path: string) {
    try { this.queueKey = join(realpathSync.native(dirname(path)), basename(path)); }
    catch { this.queueKey = resolve(path); }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.queueKey) ?? Promise.resolve();
    const next = previous.then(fn);
    mutationQueues.set(this.queueKey, next.catch(() => undefined));
    return next;
  }
  private async read(): Promise<State | null> {
    let file;
    try {
      const pathStat = await lstat(this.path);
      if (!pathStat.isFile() || pathStat.size > MAX_STORE_BYTES) throw new Error("Invalid authentication store");
      file = await open(this.path, "r");
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_STORE_BYTES || before.dev !== pathStat.dev || before.ino !== pathStat.ino)
        throw new Error("Invalid authentication store");
      const bytes = await file.readFile();
      const after = await file.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || bytes.byteLength !== before.size) throw new Error("Invalid authentication store");
      try { return parseState(JSON.parse(bytes.toString("utf8"))); }
      catch { throw new Error("Invalid authentication store"); }
    }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    finally { await file?.close(); }
  }
  private async write(state: State): Promise<void> {
    const validated = parseState(JSON.parse(JSON.stringify(state)));
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let temporary;
    try {
      temporary = await open(tmp, "wx", 0o600);
      await temporary.writeFile(JSON.stringify(validated));
      await temporary.sync();
      await temporary.chmod(0o600);
      await temporary.close(); temporary = undefined;
      await rename(tmp, this.path);
      await chmod(this.path, 0o600);
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await temporary?.close().catch(() => undefined);
      await unlink(tmp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async initialized(): Promise<boolean> { return (await this.read()) !== null; }
  private session(state: State, account: Account): SessionContext {
    return {
      user: { id: account.id, email: account.email, displayName: account.displayName },
      tenant: { id: state.workspace.id, name: state.workspace.name, slug: state.workspace.id, status: "active" },
      roleIds: [account.role],
      permissions: account.role === "project_reader" ? [...projectReaderPermissions] : [...ownerPermissions],
    };
  }
  private issue(state: State, account: Account): { token: string; session: SessionContext } {
    const token = randomBytes(32).toString("base64url");
    const current = state.sessions.filter((entry) => entry.expires > Date.now());
    const own = current.filter((entry) => entry.userId === account.id).slice(-(MAX_SESSIONS_PER_ACCOUNT - 1));
    state.sessions = [...current.filter((entry) => entry.userId !== account.id), ...own];
    state.sessions.push({ hash: sha256(token), userId: account.id, expires: Date.now() + SESSION_MS });
    return { token, session: this.session(state, account) };
  }
  private owner(state: State, session: SessionContext): Account {
    const account = state.accounts.find((candidate) => candidate.id === session.user.id);
    if (!account || account.status !== "active" || !["owner", "platform_admin"].includes(account.role) ||
      state.workspace.id !== session.tenant.id)
      throw new AuthError("Nur Administratoren dürfen das Team verwalten.", 403);
    return account;
  }
  limit(ip: string): void {
    const now = Date.now(); for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    if (!this.attempts.has(ip) && this.attempts.size >= 10_000)
      throw new AuthError("Anmeldung vorübergehend ausgelastet. Bitte später erneut versuchen.", 429);
    const entry = this.attempts.get(ip) ?? { count: 0, until: now + 15 * 60 * 1000 };
    entry.count++; this.attempts.set(ip, entry);
    if (entry.count > 10) throw new AuthError("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", 429);
  }
  setup(input: Record<string, unknown>): Promise<{ token: string; session: SessionContext }> {
    return this.serial(async () => {
      if (await this.read()) throw new AuthError("Dieser Arbeitsbereich ist bereits eingerichtet.", 409);
      const email = text(input.email, 254).toLowerCase(); const displayName = text(input.displayName, 100);
      const name = text(input.workspaceName, 100); const password = typeof input.password === "string" ? input.password : "";
      if (!emailPattern.test(email) || !displayName || !name || password.length < 15 || password.length > 256)
        throw new AuthError("Name, Firmenname und gültige E-Mail sind erforderlich. Das Passwort braucht 15 bis 256 Zeichen.");
      const passwordSalt = randomBytes(16).toString("hex");
      const account: Account = { id: randomUUID(), email, displayName, role: "owner", status: "active",
        salt: passwordSalt, digest: (await derive(password, passwordSalt)).toString("hex") };
      const state: State = { version: 2, workspace: { id: "demo", name }, accounts: [account], sessions: [] };
      const result = this.issue(state, account); await this.write(state); return result;
    });
  }
  async login(input: Record<string, unknown>): Promise<{ token: string; session: SessionContext }> {
    const state = await this.read(); const email = text(input.email, 254).toLowerCase();
    const password = typeof input.password === "string" && input.password.length <= 256 ? input.password : "";
    const account = state?.accounts.find((candidate) => candidate.email === email && candidate.status === "active");
    const derived = await derive(password, account?.salt ?? "00000000000000000000000000000000");
    const expected = account?.digest ? Buffer.from(account.digest, "hex") : Buffer.alloc(64);
    if (!state || !account || !timingSafeEqual(derived, expected)) throw new AuthError("E-Mail oder Passwort ist nicht korrekt.", 401);
    return this.serial(async () => {
      const current = await this.read(); const currentAccount = current?.accounts.find((candidate) => candidate.id === account.id);
      if (!current || !currentAccount || currentAccount.status !== "active" || currentAccount.digest !== account.digest)
        throw new AuthError("Bitte erneut anmelden.", 401);
      const result = this.issue(current, currentAccount); await this.write(current); return result;
    });
  }

  loginOidc(input: { issuer: string; subject: string; email: string; displayName: string }): Promise<{ token: string; session: SessionContext }> {
    return this.serial(async () => {
      const state = await this.read();
      if (!state) throw new AuthError("Der Arbeitsbereich ist noch nicht eingerichtet.", 409);
      const issuer = text(input.issuer, 512);
      const subject = text(input.subject, 512);
      const email = text(input.email, 254).toLowerCase();
      const displayName = text(input.displayName, 100);
      if (!issuer || !subject || !emailPattern.test(email) || !displayName) throw new AuthError("Ungültige SSO-Identität.", 401);

      let account = state.accounts.find(candidate => candidate.oidcIssuer === issuer && candidate.oidcSubject === subject);
      if (account) {
        if (account.status !== "active" || !["owner", "platform_admin"].includes(account.role))
          throw new AuthError("Dieser SSO-Zugang ist deaktiviert.", 403);
        const emailOwner = state.accounts.find(candidate => candidate.email === email && candidate.id !== account!.id);
        if (emailOwner) throw new AuthError("Die SSO-E-Mail ist bereits einem anderen Zugang zugeordnet.", 409);
        account.email = email;
        account.displayName = displayName;
      } else {
        const sameEmail = state.accounts.find(candidate => candidate.email === email);
        if (sameEmail) {
          if (sameEmail.status !== "active" || !["owner", "platform_admin"].includes(sameEmail.role) ||
            sameEmail.oidcIssuer || sameEmail.oidcSubject)
            throw new AuthError("Dieser SSO-Zugang kann nicht automatisch verknüpft werden.", 409);
          sameEmail.oidcIssuer = issuer;
          sameEmail.oidcSubject = subject;
          sameEmail.displayName = displayName;
          account = sameEmail;
        } else {
          if (state.accounts.length >= MAX_ACCOUNTS) throw new AuthError("Die maximale Teamgröße ist erreicht.", 409);
          account = {
            id: randomUUID(),
            email,
            displayName,
            role: "platform_admin",
            status: "active",
            oidcIssuer: issuer,
            oidcSubject: subject,
          };
          state.accounts.push(account);
        }
      }
      const result = this.issue(state, account);
      await this.write(state);
      return result;
    });
  }

  async authenticate(token: string | undefined): Promise<SessionContext | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const state = await this.read(); if (!state) return null;
    const stored = state.sessions.find((entry) => entry.hash === sha256(token) && entry.expires > Date.now());
    const account = stored && state.accounts.find((candidate) => candidate.id === stored.userId && candidate.status === "active");
    return account ? this.session(state, account) : null;
  }
  /** Resolves an accepted job or request against the current account state. */
  async resolvePrincipal(reference: { userId: string; tenantId: string }): Promise<SessionContext | null> {
    const state = await this.read();
    const account = state?.workspace.id === reference.tenantId
      ? state.accounts.find((candidate) => candidate.id === reference.userId && candidate.status === "active") : undefined;
    return state && account ? this.session(state, account) : null;
  }
  logout(token: string | undefined): Promise<void> {
    return this.serial(async () => {
      const state = await this.read(); if (!state || !token) return;
      state.sessions = state.sessions.filter((entry) => entry.hash !== sha256(token) && entry.expires > Date.now());
      await this.write(state);
    });
  }
  async listTeam(session: SessionContext): Promise<TeamMember[]> {
    const state = await this.read(); if (!state) throw new AuthError("Arbeitsbereich nicht gefunden.", 404);
    this.owner(state, session); return state.accounts.filter((account) => account.role === "project_reader").map(teamMember);
  }
  invite(session: SessionContext, raw: { email: string; displayName: string }): Promise<{ member: TeamMember; token: string; expiresAt: string }> {
    return this.serial(async () => {
      const state = await this.read(); if (!state) throw new AuthError("Arbeitsbereich nicht gefunden.", 404); this.owner(state, session);
      if (!record(raw) || !exactKeys(raw, ["email", "displayName"])) throw new AuthError("Ungültige Eingabe.");
      const email = text(raw.email, 254).toLowerCase(); const displayName = text(raw.displayName, 100);
      if (!emailPattern.test(email) || !displayName) throw new AuthError("Name und gültige E-Mail sind erforderlich.");
      if (state.accounts.some((account) => account.email === email)) throw new AuthError("Für diese E-Mail besteht bereits ein Konto.", 409);
      if (state.accounts.length >= MAX_ACCOUNTS) throw new AuthError("Die maximale Teamgröße ist erreicht.", 409);
      const token = randomBytes(32).toString("base64url"); const expires = Date.now() + INVITATION_MS;
      const account: Account = { id: randomUUID(), email, displayName, role: "project_reader", status: "invited",
        invitation: { hash: sha256(token), expires } };
      state.accounts.push(account); await this.write(state);
      return { member: teamMember(account), token, expiresAt: new Date(expires).toISOString() };
    });
  }
  renewInvitation(session: SessionContext, id: string): Promise<{ member: TeamMember; token: string; expiresAt: string }> {
    return this.serial(async () => {
      const state = await this.read(); if (!state) throw new AuthError("Arbeitsbereich nicht gefunden.", 404); this.owner(state, session);
      const account = state.accounts.find((candidate) => candidate.id === id && candidate.role === "project_reader");
      if (!account) throw new AuthError("Teammitglied nicht gefunden.", 404);
      if (account.status !== "invited") throw new AuthError("Nur offene Einladungen können erneuert werden.", 409);
      const token = randomBytes(32).toString("base64url"); const expires = Date.now() + INVITATION_MS;
      account.invitation = { hash: sha256(token), expires }; await this.write(state);
      return { member: teamMember(account), token, expiresAt: new Date(expires).toISOString() };
    });
  }
  setMemberStatus(session: SessionContext, id: string, raw: { status: "active" | "disabled" }): Promise<TeamMember> {
    return this.serial(async () => {
      const state = await this.read(); if (!state) throw new AuthError("Arbeitsbereich nicht gefunden.", 404); this.owner(state, session);
      if (!record(raw) || !exactKeys(raw, ["status"]) || !["active", "disabled"].includes(String(raw.status)))
        throw new AuthError("Ungültiger Kontostatus.");
      const account = state.accounts.find((candidate) => candidate.id === id && candidate.role === "project_reader");
      if (!account) throw new AuthError("Teammitglied nicht gefunden.", 404);
      if (account.status === "invited") throw new AuthError("Die Einladung muss zuerst mit einem Passwort angenommen werden.", 409);
      if (!account.salt || !account.digest) throw new AuthError("Dieses Konto kann nicht aktiviert werden.", 409);
      account.status = raw.status;
      if (raw.status === "disabled") state.sessions = state.sessions.filter((entry) => entry.userId !== account.id);
      await this.write(state); return teamMember(account);
    });
  }
  async acceptInvitation(raw: { token: string; password: string }): Promise<{ token: string; session: SessionContext }> {
    if (!record(raw) || !exactKeys(raw, ["token", "password"])) throw new AuthError("Ungültige Einladung.");
    const invitationToken = typeof raw.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw.token) ? raw.token : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    if (!invitationToken || password.length < 15 || password.length > 256) throw new AuthError("Einladung oder Passwort ist ungültig.");
    const invitationHash = sha256(invitationToken); const initial = await this.read();
    const invited = initial?.accounts.find((account) => account.status === "invited" &&
      account.invitation?.hash === invitationHash && account.invitation.expires > Date.now());
    if (!initial || !invited) throw new AuthError("Diese Einladung ist ungültig oder abgelaufen.");
    const passwordSalt = randomBytes(16).toString("hex"); const passwordDigest = (await derive(password, passwordSalt)).toString("hex");
    return this.serial(async () => {
      const state = await this.read(); const account = state?.accounts.find((candidate) => candidate.id === invited.id);
      if (!state || !account || account.status !== "invited" || account.invitation?.hash !== invitationHash || account.invitation.expires <= Date.now())
        throw new AuthError("Diese Einladung ist ungültig oder abgelaufen.");
      account.status = "active"; account.salt = passwordSalt; account.digest = passwordDigest; delete account.invitation;
      const result = this.issue(state, account); await this.write(state); return result;
    });
  }
}
