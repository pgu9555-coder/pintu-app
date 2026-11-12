/* Pintu NYC — configuration.
 *
 * Leave both values empty to run in local mode (one browser, synced across
 * its tabs) — good for trying it out.
 *
 * For real-time rooms across phones, create a free Supabase project, run
 * supabase/schema.sql in its SQL editor, then paste from
 * Project Settings → API:
 *   SUPABASE_URL      = the "Project URL"
 *   SUPABASE_ANON_KEY = the "anon public" key (safe to ship in the browser;
 *                       access is governed by the policies in schema.sql)
 */
window.PINTU_CONFIG = {
  SUPABASE_URL: 'https://dgsyrzbdwqtmhisdoiyf.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnc3lyemJkd3F0bWhpc2RvaXlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MDE0MzUsImV4cCI6MjEwNDM3NzQzNX0.VtKvZtA7p8uLx14cxDEvOod32_IQ-OO-YxrZiT2VZaU',
};
