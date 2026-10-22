'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  api,
  getAccessToken,
  setAccessToken,
  type Role,
  type Session,
  type User,
} from './api';

/**
 * Client-side auth context. On mount a stored access token is exchanged for a
 * fresh session via the refresh cookie (self-healing); login/signup store the
 * session; signOut revokes server-side and clears local state.
 */
interface AuthState {
  user: User | null;
  workspaceId: string | null;
  role: Role | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  signIn: (email: string, password: string, totpCode?: string) => Promise<void>;
  signUp: (input: {
    email: string;
    password: string;
    name: string;
    workspaceName: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMPTY: AuthState = { user: null, workspaceId: null, role: null, loading: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...EMPTY, loading: true });

  const applySession = useCallback((session: Session) => {
    setAccessToken(session.accessToken);
    setState({
      user: session.user,
      workspaceId: session.workspaceId,
      role: session.role,
      loading: false,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getAccessToken()) {
        if (!cancelled) setState(EMPTY);
        return;
      }
      try {
        const session = await api.refresh();
        if (!cancelled) applySession(session);
      } catch {
        setAccessToken(null);
        if (!cancelled) setState(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn: async (email, password, totpCode) => {
        const res = await api.login(email, password, totpCode);
        if ('requires2fa' in res) throw new Error('Two-factor code required');
        applySession(res);
      },
      signUp: async (input) => {
        applySession(await api.signup(input));
      },
      signOut: async () => {
        try {
          await api.logout();
        } catch {
          /* local sign-out regardless */
        }
        setAccessToken(null);
        setState(EMPTY);
      },
    }),
    [state, applySession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
