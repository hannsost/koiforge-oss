import type { SemanticPrincipal } from '../semantic-model/contracts.js';

export class ProjectError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export interface ProjectEvent {
  revision: number; at: string; actorId: string; kind: 'created' | 'updated';
  addedFamilies: string[]; removedFamilies: string[]; addedMembers: string[]; removedMembers: string[];
}
export interface Project {
  id: string; tenantId: string; ownerId: string; name: string; description: string;
  revision: number; createdAt: string; updatedAt: string;
  familyIds: string[]; memberIds: string[]; events: ProjectEvent[];
}
export interface ProjectSummary {
  id: string; name: string; description: string; revision: number; updatedAt: string;
  familyCount: number; memberCount: number; canManage: boolean;
}
export interface ProjectDetail extends ProjectSummary {
  familyIds: string[]; memberIds?: string[]; events?: ProjectEvent[];
}
export interface ProjectAccess { principal: SemanticPrincipal; familyIds: string[]; revision: number }
