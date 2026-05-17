import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ProBid] Uncaught error:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = "/";
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen bg-brand-bg flex flex-col items-center justify-center px-4 text-center">
        <div className="max-w-md w-full">
          <div className="text-5xl mb-6">⚠️</div>
          <h1 className="text-2xl font-black text-brand-textPrimary mb-3">
            Something went wrong
          </h1>
          <p className="text-brand-textMuted text-sm mb-8">
            An unexpected error occurred. Your data is safe — refreshing the page
            usually fixes this.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 bg-brand-green text-brand-bg font-bold rounded-xl hover:opacity-90 transition-opacity text-sm"
            >
              Refresh Page
            </button>
            <button
              onClick={this.handleReset}
              className="px-6 py-3 border border-brand-border text-brand-textMuted rounded-xl hover:text-brand-textPrimary transition-colors text-sm"
            >
              Go Home
            </button>
          </div>
          {(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV && this.state.error && (
            <pre className="mt-8 text-left text-xs text-red-400 bg-brand-card border border-brand-border rounded-xl p-4 overflow-auto max-h-48">
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
