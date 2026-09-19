import type { ComponentType } from 'react';

/** Draft access shared by optional prompt actions. Applying never sends. */
export type PromptActionContext = {
  value: string;
  onValueChange: (value: string) => void;
  scopeKey: string;
  purpose: string;
  disabled: boolean;
  maxLength?: number;
};

export type PromptAction = {
  id: string;
  Component: ComponentType<PromptActionContext>;
};

/** Built-in actions use the same field contract as any future contribution. */
export const promptActions: readonly PromptAction[] = [];
