import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      let friendly = this.state.error.message;
      try {
        const parsed = JSON.parse(friendly) as { error?: string; operationType?: string; path?: string };
        if (parsed?.error) {
          friendly = `Database ${parsed.operationType || 'operation'} blocked${parsed.path ? ` (${parsed.path})` : ''}: ${parsed.error}`;
        }
      } catch {
        // Use raw message
      }

      return (
        <div className="flex h-full w-full items-center justify-center bg-slate-100 p-6 text-slate-900">
          <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">Something went wrong</h2>
            <p className="mt-2 text-xs text-slate-600 break-words">{friendly}</p>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 cursor-pointer"
            >
              Reload View
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
