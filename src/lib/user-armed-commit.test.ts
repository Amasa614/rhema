import { describe, expect, it, vi } from "vitest"
import { armOnActivationKey, createArmedCommit } from "./user-armed-commit"

describe("createArmedCommit", () => {
  it("ignores commits that were not armed by the user", () => {
    const onChange = vi.fn()
    const control = createArmedCommit(onChange)

    control.commit(false)

    expect(onChange).not.toHaveBeenCalled()
  })

  it("applies the next commit after the user arms the control", () => {
    const onChange = vi.fn()
    const control = createArmedCommit(onChange)

    control.arm()
    control.commit(true)

    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("requires a new arm before a second commit", () => {
    const onChange = vi.fn()
    const control = createArmedCommit(onChange)

    control.arm()
    control.commit(false)
    control.commit(true)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it("arms from Space or Enter", () => {
    const arm = vi.fn()
    armOnActivationKey({ key: " " }, arm)
    armOnActivationKey({ key: "Enter" }, arm)
    armOnActivationKey({ key: "Tab" }, arm)
    expect(arm).toHaveBeenCalledTimes(2)
  })
})
