import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last line of defence: if a screen throws, show a way back instead of a
 * blank page. Reloading also picks up a fixed deploy or fresh data.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled error', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="splash" role="alert">
        <span className="tile tile--brand">NOLA</span>
        <p>Something went wrong on this screen.</p>
        <button type="button" className="button" onClick={() => location.assign(import.meta.env.BASE_URL)}>
          Reload the map
        </button>
      </div>
    );
  }
}
