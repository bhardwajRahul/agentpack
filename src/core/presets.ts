export const BUDGET_PRESET_NAMES = ["quick", "chat", "agent", "deep"] as const;

export type BudgetPreset = typeof BUDGET_PRESET_NAMES[number];

export const BUDGET_PRESETS = {
  quick: 1200,
  chat: 4000,
  agent: 8000,
  deep: 16000
} as const satisfies Record<BudgetPreset, number>;

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

export function isBudgetPreset(value: string): value is BudgetPreset {
  return BUDGET_PRESET_NAMES.includes(value as BudgetPreset);
}
