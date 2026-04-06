import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../config';
import type { AuthResponse, User } from '../types';

const TOKEN_KEY = 'angel_ai_v2_token';
const REFRESH_TOKEN_KEY = 'angel_ai_v2_refresh_token';

export async function getStoredToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function storeToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

async function storeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

async function getStoredRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

export async function login(email: string, password: string): Promise<User> {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(error.error || error.message || 'Login failed');
  }

  const json = await response.json();
  const data: AuthResponse = json.data ?? json;
  await storeToken(data.accessToken);
  if (data.refreshToken) await storeRefreshToken(data.refreshToken);
  return data.user;
}

export async function register(email: string, password: string, name: string): Promise<User> {
  const response = await fetch(`${API_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Registration failed' }));
    throw new Error(error.error || error.message || 'Registration failed');
  }

  const json = await response.json();
  const data: AuthResponse = json.data ?? json;
  await storeToken(data.accessToken);
  if (data.refreshToken) await storeRefreshToken(data.refreshToken);
  return data.user;
}

export async function loginWithApple(
  identityToken: string,
  fullName?: { givenName?: string | null; familyName?: string | null } | null
): Promise<User> {
  const response = await fetch(`${API_URL}/api/auth/apple`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken, fullName }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Apple sign-in failed' }));
    throw new Error(error.error || error.message || 'Apple sign-in failed');
  }

  const json = await response.json();
  const data: AuthResponse = json.data ?? json;
  await storeToken(data.accessToken);
  if (data.refreshToken) await storeRefreshToken(data.refreshToken);
  return data.user;
}

export async function logout(): Promise<void> {
  await clearTokens();
}

export async function refreshToken(): Promise<string> {
  const storedRefresh = await getStoredRefreshToken();
  if (!storedRefresh) throw new Error('No refresh token available');

  const response = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: storedRefresh }),
  });

  if (!response.ok) {
    await clearTokens();
    throw new Error('Token refresh failed');
  }

  const json = await response.json();
  const data = json.data ?? json;
  await storeToken(data.accessToken);
  if (data.refreshToken) await storeRefreshToken(data.refreshToken);
  return data.accessToken;
}
