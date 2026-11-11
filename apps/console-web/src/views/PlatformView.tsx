import { useCallback, useEffect, useState } from 'react';

import {
  bootstrapExamples,
  fetchCapabilities,
  fetchConnectors,
  fetchModules,
  fetchResolvedConfig,
  fetchRoles,
  fetchTenants,
  fetchUiContributions,
  fetchUsers,
  type CapabilityRegistration,
  type ConnectorDefinition,
  type ModuleRecord,
  type ResolvedConfigEntry,
  type RoleRecord,
  type SessionContext,
  type TenantRecord,
  type UiSlotRegistration,
  type UserRecord,
} from '../api';
import { ActionButton, Badge, Card, StatusDot } from '../components/ui';

const coreSlots = ['object-detail-sidebar@1', 'dashboard-main@1', 'object-list-toolbar@1'];

interface PlatformViewProps {
  session: SessionContext | null;
}

export function PlatformView({ session }: PlatformViewProps) {
  const [resolvedConfig, setResolvedConfig] = useState<ResolvedConfigEntry[]>([]);
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [modules, setModules] = useState<ModuleRecord[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityRegistration[]>([]);
  const [uiContributions, setUiContributions] = useState<UiSlotRegistration[]>([]);
  const [connectors, setConnectors] = useState<ConnectorDefinition[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchResolvedConfig(), fetchTenants(), fetchRoles(), fetchUsers(), fetchModules(), fetchCapabilities(), fetchUiContributions(), fetchConnectors()])
      .then(([rc, t, r, u, m, cap, ui, con]) => {
        setResolvedConfig(rc); setTenants(t); setRoles(r); setUsers(u);
        setModules(m); setCapabilities(cap); setUiContributions(ui); setConnectors(con);
      }).catch(console.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    try { await bootstrapExamples(); load(); } catch (e) { console.error(e); } finally { setBootstrapping(false); }
  }, [load]);

  const slotUsage = coreSlots.map((slot) => ({
    slot,
    contributions: uiContributions.filter((c) => c.slot === slot),
  }));

  return (
    <>
      {/* Security + Ecosystem */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Security & Config">
          <div className="space-y-3">
            {/* Session */}
            <div className="rounded border border-rim bg-ink/50 px-3 py-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Active session</div>
              <div className="text-[13px] font-medium text-white">{session?.user.displayName ?? '—'}</div>
              <div className="text-[11px] text-[#3a4e6a]">{session?.tenant.name ?? '—'}</div>
            </div>
            {/* Resolved config */}
            <div className="rounded border border-rim bg-ink/50 px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Resolved config</div>
              <div className="flex flex-wrap gap-1.5">
                {resolvedConfig.map((entry) => (
                  <Badge key={entry.key}>{entry.key}: {String(entry.resolvedValue)}</Badge>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card title="Tenants · Roles · Users">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Tenants</div>
              <div className="space-y-1">
                {tenants.map((t) => (
                  <div key={t.id} className="rounded border border-rim bg-ink/40 px-2.5 py-1.5 text-[12px]">
                    <div className="font-medium text-[#c8d6ef]">{t.name}</div>
                    <div className="text-[10px] text-[#2e415a]">{t.id}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Roles</div>
              <div className="space-y-1">
                {roles.map((r) => (
                  <div key={r.id} className="rounded border border-rim bg-ink/40 px-2.5 py-1.5 text-[12px]">
                    <div className="font-medium text-[#c8d6ef]">{r.name}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Users</div>
              <div className="space-y-1">
                {users.map((u) => (
                  <div key={u.id} className="rounded border border-rim bg-ink/40 px-2.5 py-1.5 text-[12px]">
                    <div className="font-medium text-[#c8d6ef]">{u.displayName}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Module registry + UI/Runtime */}
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card
          title="Module Registry"
          action={<ActionButton onClick={() => void bootstrap()} busy={bootstrapping} busyLabel="Installing…" label="Bootstrap Modules" />}
        >
          <div className="space-y-1.5">
            {modules.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-3 rounded border border-rim bg-ink/50 px-3 py-2.5">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusDot tone={entry.status === 'enabled' ? 'success' : 'warning'} />
                    <span className="text-[13px] font-medium text-white">{entry.id}</span>
                  </div>
                  <div className="mt-0.5 pl-3.5 text-[11px] text-[#3a4e6a]">v{entry.currentVersion}</div>
                </div>
                <Badge tone={entry.status === 'enabled' ? 'success' : 'warning'}>{entry.status}</Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card title="UI Slots & Capabilities">
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Slot registry</div>
              <div className="space-y-1">
                {slotUsage.map((entry) => (
                  <div key={entry.slot} className="flex items-center justify-between gap-2 rounded border border-rim bg-ink/50 px-3 py-2">
                    <div className="text-[11px] font-mono text-[#6b82a0]">{entry.slot}</div>
                    <Badge>{entry.contributions.length}</Badge>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Capabilities</div>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.map((entry) => (
                  <Badge key={`${entry.moduleId}-${entry.capability}`}>{entry.capability}</Badge>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Connectors */}
      <Card title="Connector Catalog">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {connectors.map((con) => (
            <div key={con.id} className="rounded border border-rim bg-ink/50 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13px] font-semibold text-white">{con.name}</div>
                <Badge>{con.category}</Badge>
              </div>
              <div className="mt-0.5 text-[11px] text-[#3a4e6a]">{con.id}</div>
              <div className="mt-2 text-[10px] text-[#2e415a]">{con.configFields.length} config fields</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
