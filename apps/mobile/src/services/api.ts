import { API_URL } from '../config';
import { getStoredToken, refreshToken, logout } from './auth';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: HttpMethod, path: string, body?: object): Promise<T> {
  let token = await getStoredToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response = await fetch(`${API_URL}/api/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && token) {
    try {
      const newToken = await refreshToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(`${API_URL}/api/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      await logout();
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorBody.error || errorBody.message || `HTTP ${response.status}`);
  }

  if (response.status === 204) return undefined as T;

  const json = await response.json();
  if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

export const api = {
  get<T>(path: string): Promise<T> { return request<T>('GET', path); },
  post<T>(path: string, body?: object): Promise<T> { return request<T>('POST', path, body); },
  put<T>(path: string, body?: object): Promise<T> { return request<T>('PUT', path, body); },
  patch<T>(path: string, body?: object): Promise<T> { return request<T>('PATCH', path, body); },
  delete<T>(path: string): Promise<T> { return request<T>('DELETE', path); },
};
