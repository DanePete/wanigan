import { useCallback, useRef, useState } from 'react';

/** Completion may clear this rendered draft only if no edit followed it. */
export function useDraft(): { text: string; setText: (text: string) => void; clear: () => void } {
  const [text, setValue] = useState('');
  const revision = useRef(0);
  const setText = useCallback((next: string) => { revision.current++; setValue(next); }, []);
  const rendered = revision.current;
  const clear = (): void => {
    if (revision.current !== rendered) return;
    revision.current++;
    setValue('');
  };
  return { text, setText, clear };
}
