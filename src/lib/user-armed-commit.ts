import { useRef } from "react"

/** Ignore Radix value changes that fire when a control unmounts with its dialog. */
export function createArmedCommit<T>(onChange: (value: T) => void) {
  let armed = false
  return {
    arm() {
      armed = true
    },
    commit(value: T) {
      if (!armed) return
      armed = false
      onChange(value)
    },
  }
}

export function armOnActivationKey(
  event: { key: string },
  arm: () => void,
): void {
  if (event.key === " " || event.key === "Enter") arm()
}

export function useArmedCommit<T>(onChange: (value: T) => void) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const apiRef = useRef<ReturnType<typeof createArmedCommit<T>> | null>(null)
  if (!apiRef.current) {
    apiRef.current = createArmedCommit((value: T) => {
      onChangeRef.current(value)
    })
  }
  return apiRef.current
}
