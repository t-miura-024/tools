import { PLAN_STATUSES } from "../plan-init-config/plan-statuses";
import type { MtPlanConfig, PlanStatus } from "../plan-init-config/types";
import { TransitionPlanError } from "./transition-plan-error";

export function isPlanStatus(value: string): value is PlanStatus {
  return PLAN_STATUSES.includes(value as PlanStatus);
}

export function assertPlanStatus(value: string): asserts value is PlanStatus {
  if (!isPlanStatus(value)) {
    throw new TransitionPlanError(
      `Unsupported target status: ${value}. Supported statuses: ${PLAN_STATUSES.join(", ")}`,
    );
  }
}

export type TransitionSideEffect = {
  itemId: string;
  number: number;
  sourceStatus: PlanStatus;
  targetStatus: PlanStatus;
  bodyUpdated: boolean;
  issueStateChanged: boolean;
  issueClosed: boolean;
};

export type IssueRelationFns = {
  getParentIssueNumber?: (params: { repo: string; number: number }) => Promise<number | null>;
  listSubIssueNumbers?: (params: { repo: string; number: number }) => Promise<number[]>;
};

export type UpdateItemStatusFn = (params: {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
}) => Promise<void>;

export type UpdateIssueStateFn = (params: {
  repo: string;
  number: number;
  state: "open" | "closed";
}) => Promise<void>;

export type UpdateIssueBodyFn = (params: {
  repo: string;
  number: number;
  body: string;
}) => Promise<void>;

export type FindPlanItemFn = (params: {
  config: MtPlanConfig;
  number: number;
  repo?: string;
}) => Promise<{ itemId: string; currentStatus: PlanStatus; repo: string }>;

export type TransitionPlanOptions = {
  config: MtPlanConfig;
  number: number;
  targetStatus: PlanStatus;
  repo?: string;
  findPlanItem?: FindPlanItemFn;
  updateItemStatus?: UpdateItemStatusFn;
  updateIssueState?: UpdateIssueStateFn;
  readIssueBody?: (params: { repo: string; number: number }) => Promise<string>;
  updateIssueBody?: UpdateIssueBodyFn;
  skipHistoryAppend?: boolean;
} & IssueRelationFns;

export type TransitionPlanResult = TransitionSideEffect & {
  parentTransition?: TransitionSideEffect;
};

export type ApplyTransitionEffectsOptions = {
  config: MtPlanConfig;
  number: number;
  repo: string;
  itemId: string;
  sourceStatus: PlanStatus;
  targetStatus: PlanStatus;
  updateItemStatus: UpdateItemStatusFn;
  updateIssueState: UpdateIssueStateFn;
  readIssueBody: (params: { repo: string; number: number }) => Promise<string>;
  updateIssueBody: UpdateIssueBodyFn;
  skipHistoryAppend: boolean;
  executionTransition: boolean;
};

export type AggregateParentStatusOptions = {
  config: MtPlanConfig;
  repo: string;
  parentNumber: number | null;
  findPlanItem: FindPlanItemFn;
  listSubIssueNumbers: NonNullable<IssueRelationFns["listSubIssueNumbers"]>;
  updateItemStatus: UpdateItemStatusFn;
  updateIssueState: UpdateIssueStateFn;
  readIssueBody: (params: { repo: string; number: number }) => Promise<string>;
  updateIssueBody: UpdateIssueBodyFn;
  skipHistoryAppend: boolean;
  childTargetStatus: PlanStatus;
  childNumber: number;
};

export type TransitionPlanCliOptions = {
  number?: number;
  targetStatus?: PlanStatus;
  repo?: string;
  configPath?: string;
  help?: boolean;
};
