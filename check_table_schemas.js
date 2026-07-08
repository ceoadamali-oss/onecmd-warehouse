import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://gqapwytzpwpvwahfdeom.supabase.co';
const supabaseKey = 'sb_publishable_EzS5QQZAONvGI8JGVE0YsQ_HxuDyzGQ';
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  // Query postgres information_schema via RPC or by checking the REST API docs
  // Since we cannot run raw sql unless there is an RPC function, we can query REST Swagger docs or run a request to /rest/v1/
  // But wait! We can inspect the swagger spec of the Supabase API!
  // In Supabase, the OpenAPI spec is exposed at: https://gqapwytzpwpvwahfdeom.supabase.co/rest/v1/?apikey=sb_publishable_EzS5QQZAONvGI8JGVE0YsQ_HxuDyzGQ
  // Let's download and log the schema!
  const res = await fetch(`${supabaseUrl}/rest/v1/?apikey=${supabaseKey}`);
  const spec = await res.json();
  console.log('Tables:', Object.keys(spec.paths || {}));
  console.log('Tire Schema:', spec.definitions?.tires_catalog?.properties ? Object.keys(spec.definitions.tires_catalog.properties) : 'no definition');
  console.log('Transaction Schema:', spec.definitions?.inventory_transactions?.properties ? Object.keys(spec.definitions.inventory_transactions.properties) : 'no definition');
}

run();
