import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://gqapwytzpwpvwahfdeom.supabase.co';
const supabaseKey = 'sb_publishable_EzS5QQZAONvGI8JGVE0YsQ_HxuDyzGQ';
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase.from('tires_catalog').select('*').limit(1);
  if (error) {
    console.error(error);
  } else {
    console.log('Columns in tires_catalog:', Object.keys(data[0] || {}));
  }
  
  const { data: txData, error: txError } = await supabase.from('inventory_transactions').select('*').limit(1);
  if (txError) {
    console.error(txError);
  } else {
    console.log('Columns in inventory_transactions:', Object.keys(txData[0] || {}));
  }
}

run();
