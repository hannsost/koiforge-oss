import type { SecurityState } from './types.js';

export function createDefaultSecurityState(): SecurityState {
  return {
    tenants: [
      {
        id: 'platform',
        name: 'Platform Tenant',
        slug: 'platform',
        status: 'active',
      },
      {
        id: 'demo',
        name: 'Demo Tenant',
        slug: 'demo',
        status: 'active',
      },
    ],
    roles: [
      {
        id: 'platform-admin',
        name: 'Platform Admin',
        permissions: [
          'modules.read',
          'modules.manage',
          'datasets.read',
          'datasets.manage',
          'datasets.snapshot',
          'views.read',
          'views.manage',
          'audit.read',
          'config.read',
          'config.manage',
          'secrets.read',
          'secrets.manage',
          'security.read',
          'security.manage',
        ],
      },
      {
        id: 'operator',
        name: 'Operator',
        permissions: [
          'modules.read',
          'datasets.read',
          'datasets.manage',
          'datasets.snapshot',
          'views.read',
          'views.manage',
          'audit.read',
          'config.read',
          'config.manage',
          'secrets.read',
          'security.read',
        ],
      },
      {
        id: 'viewer',
        name: 'Viewer',
        permissions: ['modules.read', 'datasets.read', 'views.read', 'audit.read', 'config.read', 'secrets.read', 'security.read'],
      },
    ],
    users: [
      {
        id: 'admin',
        displayName: 'KOIForge Admin',
        email: 'admin@koiforge.local',
        memberships: [
          { tenantId: 'platform', roleIds: ['platform-admin'] },
          { tenantId: 'demo', roleIds: ['platform-admin'] },
        ],
      },
      {
        id: 'ops',
        displayName: 'Operations User',
        email: 'ops@koiforge.local',
        memberships: [{ tenantId: 'demo', roleIds: ['operator'] }],
      },
      {
        id: 'analyst',
        displayName: 'Read Only Analyst',
        email: 'analyst@koiforge.local',
        memberships: [{ tenantId: 'demo', roleIds: ['viewer'] }],
      },
    ],
    defaults: {
      tenantId: 'demo',
      userId: 'admin',
    },
  };
}
