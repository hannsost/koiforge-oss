export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
}

export interface RoleRecord {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
}

export interface UserMembership {
  tenantId: string;
  roleIds: string[];
}

export interface UserRecord {
  id: string;
  displayName: string;
  email?: string;
  memberships: UserMembership[];
}

export interface SecurityState {
  tenants: TenantRecord[];
  roles: RoleRecord[];
  users: UserRecord[];
  defaults: {
    tenantId: string;
    userId: string;
  };
}

export interface SessionContext {
  user: {
    id: string;
    displayName: string;
    email?: string;
  };
  tenant: TenantRecord;
  roleIds: string[];
  permissions: string[];
}

export interface FileSecurityRegistryOptions {
  filePath: string;
}

