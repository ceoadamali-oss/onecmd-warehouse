import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Supabase credentials missing in environment variables.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

try {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('onecmd_staff_token') : null;
  if (token) {
    supabase.auth.setSession({ access_token: token, refresh_token: '' }).catch(() => {});
  }
} catch (e) {
  console.warn('Session initialization skipped:', e);
}
