-- ═══════════════════════════════════════════════════════════════════
-- Migration: nuevo envío del LUNES "La única verdad es la realidad"
-- + Desactivación del envío diario de las 20:00
-- ═══════════════════════════════════════════════════════════════════
--
-- Como parte del rediseño del envío de las 20:00 en etapas, este
-- archivo:
--  1. Crea el cron del lunes a las 20:00 ART (23:00 UTC)
--  2. Desactiva el cron 'patria-grande-20' que disparaba TODOS los días
--
-- Las etapas siguientes (martes, miércoles, jueves, viernes) sumarán
-- sus propios crons en futuras migrations.
--
-- Los crons de 07:00 y 13:00 (resúmenes personales) NO se tocan.

-- ── Paso 1: Desactivar el envío diario actual de las 20:00 ──────────
-- Lo desactivamos en lugar de borrar para poder reactivarlo si hace falta.
DO $$
BEGIN
  PERFORM cron.unschedule('patria-grande-20');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

UPDATE public.digest_schedules
SET is_active = false
WHERE name = 'Boletín 20:00';

-- ── Paso 2: Programar el cron del lunes ────────────────────────────
-- Lunes 20:00 ART = Lunes 23:00 UTC.
-- Cron: '0 23 * * 1' (minuto 0, hora 23 UTC, día-semana 1 = lunes).

DO $$
BEGIN
  PERFORM cron.unschedule('patria-grande-lun20');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'patria-grande-lun20',
  '0 23 * * 1',
  $$SELECT public.trigger_digest_pipeline('Lunes Realidad');$$
);

-- ── Paso 3: Registrar en digest_schedules para que aparezca en el panel ──
INSERT INTO public.digest_schedules (name, cron_expression, description, is_active) VALUES
  ('Lunes Realidad', '0 23 * * 1', 'Lunes 20:00 ART — "La única verdad es la realidad" (semana política/social/económica AR)', true)
ON CONFLICT DO NOTHING;
