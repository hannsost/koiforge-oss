import type { CheckRule, DataRow, RuleResult } from './types.js';

export function evaluateRule(rows: DataRow[], rule: CheckRule): RuleResult {
  const base: RuleResult = {
    ruleId: rule.id,
    ruleType: rule.ruleType,
    column: rule.column,
    passed: true,
    failureCount: 0,
    totalChecked: rows.length,
    message: '',
  };

  switch (rule.ruleType) {
    case 'not_null': {
      const col = rule.column!;
      const failures = rows.filter((r) => r[col] == null).length;
      return {
        ...base,
        passed: failures === 0,
        failureCount: failures,
        message: failures === 0
          ? `Column '${col}' has no nulls.`
          : `Column '${col}' has ${failures} null value(s).`,
      };
    }

    case 'unique': {
      const col = rule.column!;
      const seen = new Set<string>();
      let dupes = 0;
      for (const row of rows) {
        const val = String(row[col] ?? '');
        if (seen.has(val)) dupes++;
        else seen.add(val);
      }
      return {
        ...base,
        passed: dupes === 0,
        failureCount: dupes,
        message: dupes === 0
          ? `Column '${col}' is unique.`
          : `Column '${col}' has ${dupes} duplicate value(s).`,
      };
    }

    case 'regex': {
      const col = rule.column!;
      const pattern = rule.params?.pattern ?? '';
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return { ...base, passed: false, failureCount: rows.length, message: `Invalid regex: ${pattern}` };
      }
      const failures = rows.filter((r) => r[col] != null && !re.test(String(r[col]))).length;
      return {
        ...base,
        passed: failures === 0,
        failureCount: failures,
        message: failures === 0
          ? `Column '${col}' matches pattern.`
          : `Column '${col}' has ${failures} non-matching value(s).`,
      };
    }

    case 'in_range': {
      const col = rule.column!;
      const min = rule.params?.min ?? Number.NEGATIVE_INFINITY;
      const max = rule.params?.max ?? Number.POSITIVE_INFINITY;
      const failures = rows.filter((r) => {
        const v = r[col];
        if (v == null) return false;
        const n = Number(v);
        return Number.isNaN(n) || n < min || n > max;
      }).length;
      return {
        ...base,
        passed: failures === 0,
        failureCount: failures,
        message: failures === 0
          ? `Column '${col}' is within range [${min}, ${max}].`
          : `Column '${col}' has ${failures} out-of-range value(s).`,
      };
    }

    case 'min_rows': {
      const min = rule.params?.min ?? 1;
      const passed = rows.length >= min;
      return {
        ...base,
        passed,
        failureCount: passed ? 0 : 1,
        totalChecked: 1,
        message: passed
          ? `Dataset has ${rows.length} rows (≥ ${min}).`
          : `Dataset has only ${rows.length} rows (expected ≥ ${min}).`,
      };
    }

    case 'allowed_values': {
      const col = rule.column!;
      const allowed = new Set(rule.params?.values ?? []);
      const failures = rows.filter((r) => r[col] != null && !allowed.has(String(r[col]))).length;
      return {
        ...base,
        passed: failures === 0,
        failureCount: failures,
        message: failures === 0
          ? `Column '${col}' only contains allowed values.`
          : `Column '${col}' has ${failures} disallowed value(s).`,
      };
    }

    default:
      return { ...base, passed: false, failureCount: 0, message: 'Unknown rule type.' };
  }
}
