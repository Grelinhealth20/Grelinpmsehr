import { Component } from 'react';

/**
 * App-level error boundary. Without this, ANY render-time exception in the tree unmounts the whole app
 * and leaves a blank white page (with no clue why). This catches the error, logs the full detail to the
 * console for diagnosis, and shows a clear, honest message + a Reload — it never hides or fakes data.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Full detail to the console so the actual cause is diagnosable (never silently swallowed).
    // eslint-disable-next-line no-console
    console.error('[UI crash]', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="eb">
        <div className="eb-card" role="alert">
          <div className="eb-title">Something went wrong on this screen</div>
          <div className="eb-msg">{String(error?.message || error)}</div>
          <div className="eb-actions">
            <button className="btn" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn ghost" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
          <div className="eb-hint">If this keeps happening, note the message above — it names the exact fault.</div>
        </div>
      </div>
    );
  }
}
