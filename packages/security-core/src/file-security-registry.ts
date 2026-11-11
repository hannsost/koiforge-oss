import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createDefaultSecurityState } from './defaults.js';
import type {
  FileSecurityRegistryOptions,
  RoleRecord,
  SecurityState,
  SessionContext,
  TenantRecord,
  UserMembership,
  UserRecord,
} from './types.js';

function sortByName<T extends { name?: string; displayName?: string; id: string }>(left: T, right: T): number {
  return (left.name ?? left.displayName ?? left.id).localeCompare(right.name ?? right.displayName ?? right.id);
}

function mergeMemberships(existing: UserMembership[], defaults: UserMembership[]): UserMembership[] {
  const byTenant = new Map<string, UserMembership>();

  for (const membership of existing) {
    byTenant.set(membership.tenantId, {
      tenantId: membership.tenantId,
      roleIds: [...membership.roleIds],
    });
  }

  for (const membership of defaults) {
    const current = byTenant.get(membership.tenantId);
    if (!current) {
      byTenant.set(membership.tenantId, {
        tenantId: membership.tenantId,
        roleIds: [...membership.roleIds],
      });
      continue;
    }

    current.roleIds = [...new Set([...current.roleIds, ...membership.roleIds])].sort();
  }

  return [...byTenant.values()].sort((left, right) => left.tenantId.localeCompare(right.tenantId));
}

function mergeWithDefaults(state: SecurityState): SecurityState {
  const defaults = createDefaultSecurityState();

  const tenants = [...state.tenants];
  for (const tenant of defaults.tenants) {
    if (!tenants.some((entry) => entry.id === tenant.id)) {
      tenants.push(tenant);
    }
  }

  const roles = [...state.roles];
  for (const role of defaults.roles) {
    const existing = roles.find((entry) => entry.id === role.id);
    if (!existing) {
      roles.push(role);
      continue;
    }

    existing.permissions = [...new Set([...existing.permissions, ...role.permissions])].sort();
    if (!existing.description && role.description) {
      existing.description = role.description;
    }
  }

  const users = [...state.users];
  for (const user of defaults.users) {
    const existing = users.find((entry) => entry.id === user.id);
    if (!existing) {
      users.push(user);
      continue;
    }

    existing.memberships = mergeMemberships(existing.memberships, user.memberships);
    if (!existing.email && user.email) {
      existing.email = user.email;
    }
    if (!existing.displayName && user.displayName) {
      existing.displayName = user.displayName;
    }
  }

  return {
    tenants: tenants.sort(sortByName),
    roles: roles.sort(sortByName),
    users: users.sort(sortByName),
    defaults: {
      tenantId: state.defaults.tenantId || defaults.defaults.tenantId,
      userId: state.defaults.userId || defaults.defaults.userId,
    },
  };
}

export class FileSecurityRegistry {
  readonly #filePath: string;

  constructor(options: FileSecurityRegistryOptions) {
    this.#filePath = options.filePath;
  }

  async #readState(): Promise<SecurityState> {
    await mkdir(dirname(this.#filePath), { recursive: true });

    try {
      const content = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(content) as SecurityState;
      const merged = mergeWithDefaults(parsed);

      if (JSON.stringify(parsed) !== JSON.stringify(merged)) {
        await this.#writeState(merged);
      }

      return merged;
    } catch {
      const state = createDefaultSecurityState();
      await this.#writeState(state);
      return state;
    }
  }

  async #writeState(state: SecurityState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  #findTenant(state: SecurityState, tenantId: string): TenantRecord {
    const tenant = state.tenants.find((entry) => entry.id === tenantId);
    if (!tenant) {
      throw new Error(`Tenant '${tenantId}' wurde nicht gefunden.`);
    }

    return tenant;
  }

  #findUser(state: SecurityState, userId: string): UserRecord {
    const user = state.users.find((entry) => entry.id === userId);
    if (!user) {
      throw new Error(`User '${userId}' wurde nicht gefunden.`);
    }

    return user;
  }

  #findMembership(user: UserRecord, tenantId: string): UserMembership {
    const membership = user.memberships.find((entry) => entry.tenantId === tenantId);
    if (!membership) {
      throw new Error(`User '${user.id}' hat keinen Zugriff auf Tenant '${tenantId}'.`);
    }

    return membership;
  }

  #resolveRoles(state: SecurityState, roleIds: string[]): RoleRecord[] {
    return roleIds.map((roleId) => {
      const role = state.roles.find((entry) => entry.id === roleId);
      if (!role) {
        throw new Error(`Rolle '${roleId}' wurde nicht gefunden.`);
      }

      return role;
    });
  }

  async listTenants(): Promise<TenantRecord[]> {
    const state = await this.#readState();
    return [...state.tenants].sort(sortByName);
  }

  async listRoles(): Promise<RoleRecord[]> {
    const state = await this.#readState();
    return [...state.roles].sort(sortByName);
  }

  async listUsers(): Promise<UserRecord[]> {
    const state = await this.#readState();
    return [...state.users].sort(sortByName);
  }

  async getSession(input?: { userId?: string; tenantId?: string }): Promise<SessionContext> {
    const state = await this.#readState();
    const userId = input?.userId ?? state.defaults.userId;
    const tenantId = input?.tenantId ?? state.defaults.tenantId;

    const tenant = this.#findTenant(state, tenantId);
    const user = this.#findUser(state, userId);
    const membership = this.#findMembership(user, tenantId);
    const roles = this.#resolveRoles(state, membership.roleIds);
    const permissions = [...new Set(roles.flatMap((entry) => entry.permissions))].sort();

    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      },
      tenant,
      roleIds: membership.roleIds,
      permissions,
    };
  }

  hasPermissions(session: SessionContext, requiredPermissions: string[]): boolean {
    return requiredPermissions.every((permission) => session.permissions.includes(permission));
  }

  assertPermissions(session: SessionContext, requiredPermissions: string[]): void {
    const missing = requiredPermissions.filter((permission) => !session.permissions.includes(permission));
    if (missing.length > 0) {
      throw new Error(`Fehlende Berechtigung: ${missing.join(', ')}`);
    }
  }
}
