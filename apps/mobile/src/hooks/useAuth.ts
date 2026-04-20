import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { User } from '../types';
import {
  login as authLogin,
  register as authRegister,
  loginWithApple as authLoginWithApple,
  logout as authLogout,
  getStoredToken,
} from '../services/auth';
import { disconnectSocket } from '../services/socket';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  loginWithApple: (
    identityToken: string,
    fullName?: { givenName?: string | null; familyName?: string | null } | null
  ) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const token = await getStoredToken();
      if (token) {
        const userData = await api.get<User>('auth/me');
        setUser(userData);
        // Phase A: register device for push notifications — non-blocking.
        // Fire-and-forget; failures shouldn't block auth.
        import('../services/notifications')
          .then((mod) => mod.setupPushNotifications())
          .catch(() => {});
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const maybeRegisterPush = () => {
    import('../services/notifications')
      .then((mod) => mod.setupPushNotifications())
      .catch(() => {});
  };

  const login = useCallback(async (email: string, password: string) => {
    const userData = await authLogin(email, password);
    setUser(userData);
    maybeRegisterPush();
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    const userData = await authRegister(email, password, name);
    setUser(userData);
    maybeRegisterPush();
  }, []);

  const loginWithApple = useCallback(
    async (
      identityToken: string,
      fullName?: { givenName?: string | null; familyName?: string | null } | null
    ) => {
      const userData = await authLoginWithApple(identityToken, fullName);
      setUser(userData);
      maybeRegisterPush();
    },
    []
  );

  const logout = useCallback(async () => {
    disconnectSocket();
    try {
      const mod = await import('../services/notifications');
      await mod.disableNotifications();
    } catch {}
    await authLogout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, isAuthenticated: !!user, login, register, loginWithApple, logout }),
    [user, isLoading, login, register, loginWithApple, logout]
  );

  return React.createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
