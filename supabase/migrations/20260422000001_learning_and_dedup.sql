-- ═══════════════════════════════════════════════════════════════════
-- Migration: agregados para aprendizaje entre envíos y dedup robusta
-- ═══════════════════════════════════════════════════════════════════

-- 1. Notas de aprendizaje por envío (alimenta el prompt del próximo ciclo)
ALTER TABLE public.digest_sends
  ADD COLUMN IF NOT EXISTS learning_notes TEXT,
  ADD COLUMN IF NOT EXISTS digest_type TEXT DEFAULT 'group';

-- 1b. Marca de perspectiva de género en artículos
ALTER TABLE public.scraped_articles
  ADD COLUMN IF NOT EXISTS has_gender_angle BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_articles_gender ON public.scraped_articles(has_gender_angle) WHERE has_gender_angle = true;

-- 2. Tabla de URLs usadas en cada digest (dedup robusto, no depende del texto)
CREATE TABLE IF NOT EXISTS public.digest_url_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  digest_id UUID REFERENCES public.digest_sends(id) ON DELETE CASCADE,
  article_url TEXT NOT NULL,
  short_url TEXT,
  used_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_url_usage_url ON public.digest_url_usage(article_url);
CREATE INDEX IF NOT EXISTS idx_url_usage_digest ON public.digest_url_usage(digest_id);

ALTER TABLE public.digest_url_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read digest_url_usage" ON public.digest_url_usage FOR SELECT USING (true);
CREATE POLICY "Service role write digest_url_usage" ON public.digest_url_usage FOR ALL USING (true) WITH CHECK (true);

-- 3. Seeds de config por defecto
INSERT INTO public.digest_config (key, value, description)
VALUES
  ('grabois_keywords', 'Grabois,Patria Grande,Movimiento de Trabajadores Excluidos,MTE', 'Keywords para detectar contenido sobre Patria Grande'),
  ('argentina_keywords', 'Argentina,argentino,argentina,Buenos Aires,peronismo,Milei,CGT', 'Keywords para detectar contenido sobre Argentina'),
  ('gender_keywords', 'mujeres,mujer,género,feminismo,LGBTIQ,travesti,trans,disidencia,aborto,violencia de género,femicidio,transfemicidio,brecha,cuidados,maternidad,licencia paternidad', 'Keywords para detectar y priorizar contenido con perspectiva de género')
ON CONFLICT (key) DO NOTHING;
