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

-- ── Función helper que dispara run-digest-pipeline con el schedule_name ──────
-- Reemplazá '__SUPABASE_URL__' y '__SERVICE_ROLE_KEY__' al aplicar la migration.
-- Supabase inyecta estos valores automáticamente en edge functions pero no en
-- pg_cron, por eso hay que setearlos acá directo.
--
-- Si estás usando Supabase Cloud, podés setearlos como secrets del proyecto y
-- referenciarlos con `vault.decrypted_secrets`. Para empezar simple, los dejamos
-- como strings que hay que reemplazar antes de aplicar.

CREATE OR REPLACE FUNCTION public.trigger_digest_pipeline(schedule_label TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url TEXT := current_setting('app.supabase_url', true);
  service_key TEXT := current_setting('app.service_role_key', true);
BEGIN
  IF supabase_url IS NULL OR service_key IS NULL THEN
    RAISE EXCEPTION 'app.supabase_url y app.service_role_key deben estar configurados. Ver migration.';
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

-- ═══════════════════════════════════════════════════════════════════
-- CONFIGURACIÓN MANUAL REQUERIDA (una sola vez, después de aplicar):
--
-- Conectarse al SQL editor de Supabase con rol postgres y ejecutar:
--
-- ALTER DATABASE postgres SET app.supabase_url = 'https://TU-PROYECTO.supabase.co';
-- ALTER DATABASE postgres SET app.service_role_key = 'TU_SERVICE_ROLE_KEY';
--
-- Después de eso, los schedules empiezan a funcionar.
-- ═══════════════════════════════════════════════════════════════════
