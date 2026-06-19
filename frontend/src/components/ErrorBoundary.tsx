import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// Top-level boundary so a render error in any view shows a recoverable panel
// instead of a blank white screen.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('Render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-black p-6 text-center">
          <div className="text-down text-sm uppercase tracking-widest">Something broke on this screen</div>
          <pre className="max-w-2xl overflow-auto rounded-lg border border-border bg-panel p-3 text-left text-2xs text-text-dim">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              className="inline-flex items-center rounded-full border border-transparent bg-amber px-4 py-1.5 text-xs font-semibold text-black"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              className="inline-flex items-center rounded-full border border-border-2 px-4 py-1.5 text-xs text-text"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
          </div>
          <p className="text-2xs text-muted">Your data is safe — this only affected the current view.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
