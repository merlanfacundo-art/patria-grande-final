-- ═══════════════════════════════════════════════════════════════════
-- Schedule automático de los 3 envíos diarios usando pg_cron
--
-- Argentina es UTC-3 todo el año (no tiene DST).
-- 07:00 ART = 10:00 UTC
-- 13:00 ART = 16:00 UTC
-- 20:00 ART = 23:00 UTC
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Función que dispara run-digest-pipeline desde pg_cron ────────────────────
-- Lee los secrets desde Supabase Vault (encriptados).
--
-- Supabase Cloud no permite usar ALTER DATABASE SET app.* al usuario normal,
-- por eso usamos Vault. Los secrets se deben guardar manualmente una vez:
--
--   SELECT vault.create_secret('https://TU-PROYECTO.supabase.co', 'app_supabase_url', '...');
--   SELECT vault.create_secret('TU_SERVICE_ROLE_KEY', 'app_service_role_key', '...');
--
-- Ver README.md, sección "Setup desde cero" para detalles.

CREATE OR REPLACE FUNCTION public.trigger_digest_pipeline(schedule_label TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url TEXT;
  service_key TEXT;
BEGIN
  SELECT decrypted_secret INTO supabase_url
    FROM vault.decrypted_secrets WHERE name = 'app_supabase_url';
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

  IF supabase_url IS NULL OR service_key IS NULL THEN
    RAISE EXCEPTION 'Faltan secrets en vault: app_supabase_url o app_service_role_key';
  END IF;

  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/run-digest-pipeline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object('schedule_name', schedule_label)
  );
END;
$$;

-- ── Unschedule previos si existen (idempotencia) ──────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('patria-grande-07');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$
BEGIN
  PERFORM cron.unschedule('patria-grande-13');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$
BEGIN
  PERFORM cron.unschedule('patria-grande-20');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ── Schedules activos ─────────────────────────────────────────────────────────
-- 07:00 ART → 10:00 UTC → resumen personal
SELECT cron.schedule(
  'patria-grande-07',
  '0 10 * * *',
  $$SELECT public.trigger_digest_pipeline('Resumen 07:00');$$
);

-- 13:00 ART → 16:00 UTC → resumen personal
SELECT cron.schedule(
  'patria-grande-13',
  '0 16 * * *',
  $$SELECT public.trigger_digest_pipeline('Resumen 13:00');$$
);

-- 20:00 ART → 23:00 UTC → boletín grupal (auto)
SELECT cron.schedule(
  'patria-grande-20',
  '0 23 * * *',
  $$SELECT public.trigger_digest_pipeline('Boletín 20:00');$$
);
