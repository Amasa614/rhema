import { Component, type ReactNode } from "react"

export class ErrorBoundary extends Component<
  {
    children: ReactNode
    fallback: (error: unknown) => ReactNode
  },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error)
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}

