import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Supabase credentials missing in environment variables.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    get headers() {
      const token = sessionStorage.getItem('onecmd_staff_token');
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return headers;
    }
  }
});
