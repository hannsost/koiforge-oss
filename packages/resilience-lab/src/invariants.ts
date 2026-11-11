import type { InvariantResult, InvariantOperator, ResilienceSnapshot, ScenarioInvariant } from './types.js';

function evaluate(operator: InvariantOperator, observed: number | boolean | null, expected: number | boolean): boolean {
  if (observed === null) return false;

  if (operator === '==') return observed === expected;
  if (operator === '!=') return observed !== expected;

  if (typeof observed !== 'number' || typeof expected !== 'number') return false;
  if (operator === '>=') return observed >= expected;
  return observed <= expected;
}

export function evaluateInvariants(snapshot: ResilienceSnapshot, invariants: ScenarioInvariant[]): InvariantResult[] {
  return invariants.map((invariant) => {
    const observed = invariant.metric in snapshot.metrics ? snapshot.metrics[invariant.metric]! : null;
    return {
      ...invariant,
      observed,
      passed: evaluate(invariant.operator, observed, invariant.expected),
    };
  });
}

