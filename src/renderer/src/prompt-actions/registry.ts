import type { ComponentType } from 'react';
import { ImprovePromptAction } from './ImprovePromptAction';

/** Draft access shared by optional prompt actions. Applying never sends. */
export type PromptActionContext = {
  value: string;
  onValueChange: (value: string) => void;
  scopeKey: string;
  purpose: string;
  disabled: boolean;
  maxLength?: number;
  /** Check the live field as well as React state before replacing a draft. */
  isCurrent: (original: string) => boolean;
};

export type PromptAction = {
  id: string;
  Component: ComponentType<PromptActionContext>;
};

/** Built-in actions use the same field contract as any future contribution. */
export const promptActions: readonly PromptAction[] = [
  { id: 'prompt-improve', Component: ImprovePromptAction },
];
