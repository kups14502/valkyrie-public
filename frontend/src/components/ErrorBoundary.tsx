import { Component, type ErrorInfo, type ReactNode } from 'react'

// `compact` renders an inline card (keeps the surrounding shell/nav visible) —
// used for the per-route boundary. Default is the full-screen crash page used
// at the app root.
type Props = { children: ReactNode; compact?: boolean }
type State = { hasError: boolean; message?: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Unknown render error' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[master-control] render crash', error, info)
  }

  render() {
    if (this.state.hasError) {
      // Compact: inline card so the shell/nav stay usable and navigating away
      // (which remounts this boundary via its key) recovers the app.
      if (this.props.compact) {
        return (
          <div style={{ margin: '24px auto', maxWidth: '840px', border: '1px solid rgba(255,95,114,0.35)', borderRadius: '12px', padding: '20px', background: 'rgba(20,10,16,0.92)', color: '#e6f1ff' }}>
            <div style={{ fontSize: '11px', letterSpacing: '0.28em', textTransform: 'uppercase', color: '#ff8b98' }}>Page crashed</div>
            <p style={{ marginTop: '10px', color: '#b9c7d8' }}>This page hit a client-side error. Switch tabs and back, or reload.</p>
            <pre style={{ marginTop: '12px', whiteSpace: 'pre-wrap', color: '#ffd3d9' }}>{this.state.message}</pre>
          </div>
        )
      }
      return (
        <div style={{ minHeight: '100vh', background: '#05070b', color: '#e6f1ff', padding: '32px', fontFamily: 'Inter, system-ui, sans-serif' }}>
          <div style={{ maxWidth: '840px', margin: '0 auto', border: '1px solid rgba(255,95,114,0.35)', borderRadius: '16px', padding: '24px', background: 'rgba(20,10,16,0.92)' }}>
            <div style={{ fontSize: '12px', letterSpacing: '0.28em', textTransform: 'uppercase', color: '#ff8b98' }}>Master Control Crash</div>
            <h1 style={{ marginTop: '12px', marginBottom: '12px', fontSize: '28px' }}>Frontend render failed</h1>
            <p style={{ color: '#b9c7d8' }}>The dashboard hit a client-side error before it could render.</p>
            <pre style={{ marginTop: '16px', whiteSpace: 'pre-wrap', color: '#ffd3d9' }}>{this.state.message}</pre>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
