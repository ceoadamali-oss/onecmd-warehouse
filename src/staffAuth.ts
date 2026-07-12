import { supabase } from './supabaseClient';

const TOKEN_KEY = 'onecmd_staff_token';

export function getStaffToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStaffToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  if (token) {
    supabase.auth.setSession({ access_token: token, refresh_token: '' }).catch(() => {});
  }
}

export function clearStaffToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  supabase.auth.signOut().catch(() => {});
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  const token = getStaffToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
