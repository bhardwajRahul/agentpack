export const BUDGET_PRESETS = {
  quick: 1200,
  chat: 4000,
  agent: 8000,
  deep: 16000
} as const;

export type BudgetPreset = keyof typeof BUDGET_PRESETS;

export function resolveBudget(input: { budget?: number; preset?: string }, fallback = 0): number {
  if (input.budget && input.budget > 0) {
    return input.budget;
  }

  if (input.preset && isBudgetPreset(input.preset)) {
    return BUDGET_PRESETS[input.preset];
  }

  return fallback;
}

export function formatBudgetPresets(): string {
  return Object.entries(BUDGET_PRESETS)
    .map(([name, budget]) => `${name}: ${budget}`)
    .join(", ");
}

function isBudgetPreset(value: string): value is BudgetPreset {
  return value === "quick" || value === "chat" || value === "agent" || value === "deep";
}
