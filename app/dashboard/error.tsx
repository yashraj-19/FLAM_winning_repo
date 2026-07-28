'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Must be a Client Component - it holds the reset handler and catches errors
 * thrown during client rendering, which is where a canvas or worker failure
 * would surface.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard failed to render:', error);
  }, [error]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'flex-start',
        padding: '48px 24px',
        maxWidth: 520,
        margin: '0 auto',
        color: '#c3c2b7',
      }}
    >
      <h1 style={{ fontSize: '1.125rem', color: '#fff' }}>The dashboard stopped</h1>
      <p style={{ fontSize: '0.875rem' }}>
        {error.message || 'An unexpected error occurred while rendering the charts.'}
      </p>
      <button
        type="button"
        onClick={reset}
        style={{
          border: '1px solid rgba(255,255,255,0.2)',
          background: '#3987e5',
          color: '#fff',
          padding: '6px 14px',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: '0.8125rem',
        }}
      >
        Try again
      </button>
    </div>
  );
}
