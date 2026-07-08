import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://gqapwytzpwpvwahfdeom.supabase.co';
const supabaseKey = 'sb_publishable_EzS5QQZAONvGI8JGVE0YsQ_HxuDyzGQ';
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase.from('wheels_catalog').select('*').limit(1);
  if (error) {
    console.error(error);
  } else {
    console.log('Columns in wheels_catalog:', Object.keys(data[0] || {}));
  }
}

run();
