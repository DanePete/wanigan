import { forwardRef, useImperativeHandle, useRef, type TextareaHTMLAttributes } from 'react';
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
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => field.current!, []);
  const context: PromptActionContext = {
    value, onValueChange, scopeKey, purpose,
    disabled: !!(actionsDisabled || props.disabled || props.readOnly),
    maxLength: props.maxLength,
    isCurrent: original => !!field.current?.isConnected && field.current.getClientRects().length > 0 && field.current.value === original
      && value === original && !context.disabled && !field.current.matches(':disabled') && !field.current.readOnly,
  };
  return <>
    <textarea {...props} ref={field} aria-label={props['aria-label']} value={value}
      onChange={onChange ?? (event => onValueChange(event.currentTarget.value))} />
    {promptActions.map(({ id, Component }) => <Component key={`${scopeKey}:${id}`} {...context} />)}
  </>;
});
