
-- Create enum types
CREATE TYPE public.media_category AS ENUM (
  'nacional', 'afin', 'revista', 'analisis_politico', 'local',
  'internacional_latam', 'internacional_global', 'internacional_oriental',
  'sectorial', 'centro_de_estudio'
);

CREATE TYPE public.article_category AS ENUM (
  'politica', 'economia', 'social', 'internacional', 'opinion', 'analisis', 'local', 'energia', 'informe'
);

CREATE TYPE public.digest_status AS ENUM ('pending', 'sent', 'failed');

-- Media sources table
CREATE TABLE public.media_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  category media_category NOT NULL,
  language TEXT NOT NULL DEFAULT 'es',
  is_active BOOLEAN NOT NULL DEFAULT true,
  scrape_config JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Journalists table
CREATE TABLE public.journalists (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  media_outlet TEXT,
  topics TEXT[],
  search_keywords TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Scraped articles table
CREATE TABLE public.scraped_articles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID REFERENCES public.media_sources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  summary TEXT,
  content_markdown TEXT,
  author TEXT,
  category article_category,
  language TEXT DEFAULT 'es',
  published_at TIMESTAMP WITH TIME ZONE,
  scraped_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  is_about_argentina BOOLEAN DEFAULT false,
  is_about_grabois BOOLEAN DEFAULT false,
  is_used_in_digest BOOLEAN DEFAULT false,
  journalist_id UUID REFERENCES public.journalists(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_articles_source ON public.scraped_articles(source_id);
CREATE INDEX idx_articles_category ON public.scraped_articles(category);
CREATE INDEX idx_articles_published ON public.scraped_articles(published_at DESC);
CREATE INDEX idx_articles_scraped ON public.scraped_articles(scraped_at DESC);
CREATE INDEX idx_articles_grabois ON public.scraped_articles(is_about_grabois) WHERE is_about_grabois = true;
CREATE INDEX idx_articles_argentina ON public.scraped_articles(is_about_argentina) WHERE is_about_argentina = true;

-- Digest schedules table
CREATE TABLE public.digest_schedules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Digest sends log
CREATE TABLE public.digest_sends (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  schedule_id UUID REFERENCES public.digest_schedules(id) ON DELETE SET NULL,
  telegram_message TEXT,
  articles_count INTEGER DEFAULT 0,
  status digest_status NOT NULL DEFAULT 'pending',
  error_message TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Config key-value store
CREATE TABLE public.digest_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.media_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journalists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scraped_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digest_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digest_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digest_config ENABLE ROW LEVEL SECURITY;

-- Public read access for all tables (config panel)
CREATE POLICY "Public read media_sources" ON public.media_sources FOR SELECT USING (true);
CREATE POLICY "Public read journalists" ON public.journalists FOR SELECT USING (true);
CREATE POLICY "Public read scraped_articles" ON public.scraped_articles FOR SELECT USING (true);
CREATE POLICY "Public read digest_schedules" ON public.digest_schedules FOR SELECT USING (true);
CREATE POLICY "Public read digest_sends" ON public.digest_sends FOR SELECT USING (true);
CREATE POLICY "Public read digest_config" ON public.digest_config FOR SELECT USING (true);

-- Service role write access (edge functions)
CREATE POLICY "Service role write media_sources" ON public.media_sources FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role write journalists" ON public.journalists FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role write scraped_articles" ON public.scraped_articles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role write digest_schedules" ON public.digest_schedules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role write digest_sends" ON public.digest_sends FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role write digest_config" ON public.digest_config FOR ALL USING (true) WITH CHECK (true);

-- Update timestamp function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_media_sources_updated_at BEFORE UPDATE ON public.media_sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_digest_config_updated_at BEFORE UPDATE ON public.digest_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_media_sources_ts BEFORE UPDATE ON public.media_sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
