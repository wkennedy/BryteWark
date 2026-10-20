import { useRef, type MutableRefObject } from 'react';

// The value from the latest render, for an effect that must use it without
// re-running when it changes (a language switch gives `t` a new identity).
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
