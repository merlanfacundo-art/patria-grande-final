-- ═══════════════════════════════════════════════════════════════════
-- Migration: agregar boletín semanal de los sábados a las 10:00 ART
-- ═══════════════════════════════════════════════════════════════════
--
-- Este schedule es ADICIONAL a los 3 envíos diarios.
-- No modifica los existentes (07:00, 13:00, 20:00).
--
-- Sábado 10:00 ART = Sábado 13:00 UTC.
-- Cron: '0 13 * * 6' (minuto 0, hora 13 UTC, día-semana 6 = sábado).

-- Idempotencia: borrar si ya existe
DO $$
BEGIN
  PERFORM cron.unschedule('patria-grande-sab10');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Programar el nuevo schedule semanal
SELECT cron.schedule(
  'patria-grande-sab10',
  '0 13 * * 6',
  $$SELECT public.trigger_digest_pipeline('Semanal Sábado');$$
);

-- Registrar el schedule en la tabla digest_schedules para que aparezca en el panel
INSERT INTO public.digest_schedules (name, cron_expression, description, is_active) VALUES
  ('Semanal Sábado', '0 13 * * 6', 'Boletín semanal por áreas de trabajo (Sábados 10:00 ART)', true)
ON CONFLICT DO NOTHING;
