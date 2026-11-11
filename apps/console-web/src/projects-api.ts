import { apiBaseUrl, authenticatedFetch } from './http';

export interface ProjectEvent {
  revision: number;
  at: string;
  actorId: string;
  kind: 'created' | 'updated';
  addedFamilies: string[];
  removedFamilies: string[];
  addedMembers: string[];
  removedMembers: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  familyCount: number;
  memberCount: number;
  canManage: boolean;
}

export interface ProjectDetail extends ProjectSummary {
  familyIds: string[];
  memberIds?: string[];
  events?: ProjectEvent[];
}

export interface ProjectFamily {
  id: string;
  name: string;
  latest?: { revision: number };
}

export interface TeamMember {
  id: string;
  email: string;
  displayName: string;
  status: 'invited' | 'active' | 'disabled';
}

export interface InvitationResult {
  member: TeamMember;
  token: string;
  expiresAt: string;
}

export class ProjectsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ProjectsApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(`${apiBaseUrl}${path}`, { ...init, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new ProjectsApiError(body?.error ?? body?.message ?? 'Der Arbeitsbereich konnte nicht geladen werden.', response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface ProjectWritePayload {
  name: string;
  description: string;
  familyIds: string[];
  memberIds: string[];
  confirmed: true;
  requestId: string;
}

export interface ProjectUpdatePayload extends ProjectWritePayload { revision: number }

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  return (await request<{ items: ProjectSummary[] }>('/api/projects', {}, signal)).items;
}

export async function fetchProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
  return (await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`, {}, signal)).project;
}

export async function createProject(payload: ProjectWritePayload, signal?: AbortSignal): Promise<ProjectDetail> {
  return (await request<{ project: ProjectDetail }>('/api/projects', json(payload), signal)).project;
}

export async function updateProject(id: string, payload: ProjectUpdatePayload, signal?: AbortSignal): Promise<ProjectDetail> {
  return (await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`, { ...json(payload), method: 'PATCH' }, signal)).project;
}

/** The family catalog is intentionally owner-unscoped; project access is enforced by object requests. */
export async function fetchProjectFamilies(signal?: AbortSignal): Promise<ProjectFamily[]> {
  return (await request<{ items: ProjectFamily[] }>('/api/object-workspace/families', {}, signal)).items;
}

export async function fetchTeam(signal?: AbortSignal): Promise<TeamMember[]> {
  return (await request<{ items: TeamMember[] }>('/api/team', {}, signal)).items;
}

export async function inviteTeamMember(email: string, displayName: string, signal?: AbortSignal): Promise<InvitationResult> {
  return request<InvitationResult>('/api/team/invites', { ...json({ email, displayName }) }, signal);
}

export async function regenerateTeamInvitation(memberId: string, signal?: AbortSignal): Promise<InvitationResult> {
  return request<InvitationResult>(`/api/team/${encodeURIComponent(memberId)}/invitation`, json({}), signal);
}

export async function setTeamMemberStatus(memberId: string, status: 'active' | 'disabled', signal?: AbortSignal): Promise<TeamMember> {
  return request<{ member: TeamMember }>(`/api/team/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }, signal).then((result) => result.member);
}
