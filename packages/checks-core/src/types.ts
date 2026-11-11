export type CheckRuleType =
  | 'not_null'      // column has no nulls
  | 'unique'        // column values are unique
  | 'regex'         // column values match pattern
  | 'in_range'      // numeric column within [min, max]
  | 'min_rows'      // dataset has at least N rows
  | 'allowed_values'; // column value is in a fixed set

export interface CheckRule {
  id: string;
  column?: string;     // not required for min_rows
  ruleType: CheckRuleType;
  params?: {
    pattern?: string;        // for regex
    min?: number;            // for in_range / min_rows
    max?: number;            // for in_range
    values?: string[];       // for allowed_values
  };
  errorMessage?: string;
}

export interface CheckDefinition {
  id: string;
  name: string;
  description: string;
  datasetId: string;
  rules: CheckRule[];
  createdAt: string;
  updatedAt: string;
}

export type CheckStatus = 'passed' | 'failed' | 'warning';

export interface RuleResult {
  ruleId: string;
  ruleType: CheckRuleType;
  column?: string;
  passed: boolean;
  failureCount: number;
  totalChecked: number;
  message: string;
}

export interface CheckRun {
  id: string;
  checkId: string;
  datasetId: string;
  status: CheckStatus;
  ruleResults: RuleResult[];
  executedAt: string;
  rowsChecked: number;
}

export interface CreateCheckInput {
  name: string;
  description: string;
  datasetId: string;
  rules: Omit<CheckRule, 'id'>[];
}

export interface ChecksRegistryState {
  checks: Record<string, CheckDefinition>;
  runs: CheckRun[];
}

export type DataRow = Record<string, string | number | boolean | null>;
