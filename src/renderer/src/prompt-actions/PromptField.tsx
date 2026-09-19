import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { promptActions, type PromptActionContext } from './registry';

type PromptFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value: string;
  onValueChange: (value: string) => void;
  scopeKey: string;
  purpose: string;
  /** A surrounding fieldset may disable editing without a textarea attribute. */
  actionsDisabled?: boolean;
};

/** Keep the native field, its events and its ref; extensions add draft actions. */
export const PromptField = forwardRef<HTMLTextAreaElement, PromptFieldProps>(function PromptField(
  { value, onValueChange, scopeKey, purpose, actionsDisabled, onChange, ...props }, ref,
) {
  const context: PromptActionContext = {
    value, onValueChange, scopeKey, purpose,
    disabled: !!(actionsDisabled || props.disabled || props.readOnly),
    maxLength: props.maxLength,
  };
  return <>
    <textarea {...props} ref={ref} aria-label={props['aria-label']} value={value}
      onChange={onChange ?? (event => onValueChange(event.currentTarget.value))} />
    {promptActions.map(({ id, Component }) => <Component key={`${scopeKey}:${id}`} {...context} />)}
  </>;
});
