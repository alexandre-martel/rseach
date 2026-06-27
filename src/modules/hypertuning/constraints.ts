import type { ParamConstraint } from '../../core/types';

export class ConstraintEvaluator {
  evaluate(
    params: Record<string, string | number | boolean>,
    constraints: ParamConstraint[],
  ): { satisfied: boolean; violations: { rule: string; reason: string }[] } {
    const violations: { rule: string; reason: string }[] = [];

    for (const constraint of constraints) {
      if (!this.checkConstraint(params, constraint.rule)) {
        violations.push({ rule: constraint.rule, reason: constraint.reason });
      }
    }

    return {
      satisfied: violations.length === 0,
      violations,
    };
  }

  private checkConstraint(params: Record<string, string | number | boolean>, rule: string): boolean {
    try {
      let expr = rule;
      for (const [key, value] of Object.entries(params)) {
        expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), String(value));
      }

      // Only evaluate simple arithmetic/comparison expressions
      if (!/^[\d\s+\-*/<>=!.()]+$/.test(expr)) {
        return true;
      }

      const fn = new Function(`return (${expr})`);
      return Boolean(fn());
    } catch {
      return true;
    }
  }
}
