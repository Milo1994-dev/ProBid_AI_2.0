import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Wraps a route and redirects unauthenticated users to /login.
 * Preserves the intended destination via `from` state for post-login redirect.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading, sessionExpired } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-brand-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-brand-indigo border-t-transparent rounded-full animate-spin" />
          <p className="text-brand-textMuted text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        state={{
          from: location.pathname,
          expired: sessionExpired,
        }}
        replace
      />
    );
  }

  return <>{children}</>;
}
