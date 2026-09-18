import type { PLAN_STATUSES } from "./plan-statuses";

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type StatusOptionMap = Record<PlanStatus, string>;

export type MtPlanConfig = {
  owner: string;
  projectNumber: number;
  projectId: string;
  statusFieldId: string;
  statusOptions: StatusOptionMap;
};

export type ProjectV2SingleSelectField = {
  id: string;
  name: string;
  options: Array<{ id: string; name: string }>;
};

export type ProjectV2Field = {
  id: string;
  name: string;
  dataType?: string;
  options?: Array<{ id: string; name: string }>;
};

export type ProjectV2Owner = {
  __typename: "User" | "Organization";
  login: string;
};

export type ProjectV2 = {
  id: string;
  number: number;
  title: string;
  owner: ProjectV2Owner;
  fields: { nodes: ProjectV2Field[] };
};

export type InitConfigOptions = {
  owner: string;
  projectNumber: number;
  statusFieldName?: string;
  configPath?: string;
  fetchProject?: (owner: string, projectNumber: number) => Promise<ProjectV2>;
  runCommand?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

export type InitConfigResultFull = {
  config: MtPlanConfig;
  configPath: string;
  project: ProjectV2;
};

export type InitConfigCliOptions = {
  owner?: string;
  projectNumber?: number;
  configPath?: string;
  help?: boolean;
};
