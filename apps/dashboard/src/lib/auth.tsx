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
  twoFactorSkipped: boolean;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  signIn: (email: string, password: string) => Promise<
    { requires2fa: true; tempToken: string } | { requires2faSetup: true } | void
  >;
  signInWithGoogle: (idToken: string) => Promise<
    { requires2fa: true; tempToken: string } | { requires2faSetup: true } | void
  >;
  acceptQrLogin: (session: Session) => void;
  completeTwoFactorLogin: (tempToken: string, code: string) => Promise<void>;
  markTwoFactorEnabled: () => void;
  markTwoFactorDisabled: () => void;
  updateUser: (updates: Partial<Pick<User, 'name' | 'email' | 'phone' | 'avatarUrl'>>) => void;
  skipTwoFactorForSession: () => Promise<void>;
  signUp: (input: {
    email: string;
    password: string;
    name: string;
    workspaceName: string;
  }) => Promise<string>;
  acceptInvitation: (token: string, input: { name?: string; password?: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMPTY: AuthState = { user: null, workspaceId: null, role: null, twoFactorSkipped: false, loading: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...EMPTY, loading: true });

  const applySession = useCallback((session: Session) => {
    setAccessToken(session.accessToken);
    setState({
      user: session.user,
      workspaceId: session.workspaceId,
      role: session.role,
      twoFactorSkipped: Boolean(session.twoFactorSkipped),
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
      signIn: async (email, password) => {
        const res = await api.login(email, password);
        if ('requires2fa' in res) {
          if (!res.tempToken) throw new Error('The two-factor challenge was invalid.');
          return { requires2fa: true, tempToken: res.tempToken };
        }
        applySession(res);
        if (!res.user.totpEnabled) return { requires2faSetup: true };
      },
      signInWithGoogle: async (idToken) => {
        const res = await api.googleLogin(idToken);
        if ('requires2fa' in res) {
          if (!res.tempToken) throw new Error('The two-factor challenge was invalid.');
          return { requires2fa: true, tempToken: res.tempToken };
        }
        applySession(res);
        if (!res.user.totpEnabled && !res.twoFactorSkipped) return { requires2faSetup: true };
      },
      acceptQrLogin: applySession,
      completeTwoFactorLogin: async (tempToken, code) => {
        applySession(await api.completeTwoFactorLogin(tempToken, code));
      },
      markTwoFactorEnabled: () => {
        setState((current) => current.user
          ? {
              ...current,
              user: { ...current.user, totpEnabled: true },
              twoFactorSkipped: false,
            }
          : current);
      },
      markTwoFactorDisabled: () => {
        setState((current) => current.user
          ? { ...current, user: { ...current.user, totpEnabled: false } }
          : current);
      },
      updateUser: (updates) => {
        setState((current) => current.user
          ? { ...current, user: { ...current.user, ...updates } }
          : current);
      },
      skipTwoFactorForSession: async () => {
        applySession(await api.skip2fa());
      },
      signUp: async (input) => {
        const result = await api.signup(input);
        return result.email;
      },
      acceptInvitation: async (token, input) => {
        applySession(await api.acceptInvitation(token, input));
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
