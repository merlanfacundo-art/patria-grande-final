-- ═══════════════════════════════════════════════════════════════════
-- Seed: medios y periodistas para Patria Grande
-- ═══════════════════════════════════════════════════════════════════

-- ── Medios nacionales grandes (hegemónicos) ───────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Clarín', 'https://www.clarin.com', 'nacional', 'es'),
  ('La Nación', 'https://www.lanacion.com.ar', 'nacional', 'es'),
  ('Infobae', 'https://www.infobae.com', 'nacional', 'es'),
  ('Ámbito', 'https://www.ambito.com', 'nacional', 'es'),
  ('Página/12', 'https://www.pagina12.com.ar', 'nacional', 'es')
ON CONFLICT DO NOTHING;

-- ── Medios afines / alternativos ──────────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('El Destape', 'https://www.eldestapeweb.com', 'afin', 'es'),
  ('El Cohete a la Luna', 'https://www.elcohetealaluna.com', 'afin', 'es'),
  ('Tiempo Argentino', 'https://www.tiempoar.com.ar', 'afin', 'es'),
  ('Socompa', 'https://socompa.info', 'afin', 'es'),
  ('Cenital', 'https://www.cenital.com', 'afin', 'es'),
  ('El Grito del Sur', 'https://elgritodelsur.com.ar', 'afin', 'es'),
  ('Panamá Revista', 'https://panamarevista.com', 'afin', 'es'),
  ('El Diario AR', 'https://www.eldiarioar.com', 'afin', 'es'),
  ('Va con Firma', 'https://vaconfirma.com.ar', 'afin', 'es'),
  ('Kranear', 'https://kranear.com.ar', 'afin', 'es')
ON CONFLICT DO NOTHING;

-- ── Revistas de análisis ─────────────────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Revista Anfibia', 'https://www.revistaanfibia.com', 'revista', 'es'),
  ('Revista Crisis', 'https://revistacrisis.com.ar', 'revista', 'es')
ON CONFLICT DO NOTHING;

-- ── Análisis político ─────────────────────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Letra P', 'https://www.letrap.com.ar', 'analisis_politico', 'es'),
  ('Perspectiva Sur', 'https://www.perspectivasur.com', 'analisis_politico', 'es'),
  ('Diagonales', 'https://diagonales.com', 'analisis_politico', 'es')
ON CONFLICT DO NOTHING;

-- ── Locales (GBA / PBA) ───────────────────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Inforegión', 'https://www.inforegion.com.ar', 'local', 'es'),
  ('InfoQuilmes', 'https://www.infoquilmes.com.ar', 'local', 'es')
ON CONFLICT DO NOTHING;

-- ── Internacionales - Latinoamérica ──────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Nodal', 'https://www.nodal.am', 'internacional_latam', 'es'),
  ('TeleSur', 'https://www.telesurtv.net', 'internacional_latam', 'es'),
  ('CELAG', 'https://www.celag.org', 'internacional_latam', 'es'),
  ('Le Monde Diplomatique', 'https://www.eldiplo.org', 'internacional_latam', 'es'),
  ('O Globo', 'https://oglobo.globo.com', 'internacional_latam', 'pt')
ON CONFLICT DO NOTHING;

-- ── Internacionales - Grandes medios globales ────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Reuters', 'https://www.reuters.com', 'internacional_global', 'en'),
  ('BBC Mundo', 'https://www.bbc.com/mundo', 'internacional_global', 'es'),
  ('DW Español', 'https://www.dw.com/es', 'internacional_global', 'es'),
  ('Al Jazeera', 'https://www.aljazeera.com', 'internacional_global', 'en'),
  ('The New York Times', 'https://www.nytimes.com/es', 'internacional_global', 'es'),
  ('The Washington Post', 'https://www.washingtonpost.com', 'internacional_global', 'en'),
  ('The Guardian', 'https://www.theguardian.com', 'internacional_global', 'en'),
  ('France 24 Español', 'https://www.france24.com/es', 'internacional_global', 'es'),
  ('EFE', 'https://www.efe.com', 'internacional_global', 'es'),
  ('AFP', 'https://www.afp.com/es', 'internacional_global', 'es'),
  ('The Economist', 'https://www.economist.com', 'internacional_global', 'en')
ON CONFLICT DO NOTHING;

-- ── Internacionales - Perspectiva oriental / Sur global ──────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('Xinhua Español', 'http://spanish.news.cn', 'internacional_oriental', 'es'),
  ('CGTN Español', 'https://espanol.cgtn.com', 'internacional_oriental', 'es'),
  ('Sputnik Mundo', 'https://sputniknews.lat', 'internacional_oriental', 'es'),
  ('People''s Daily Español', 'http://spanish.peopledaily.com.cn', 'internacional_oriental', 'es')
ON CONFLICT DO NOTHING;

-- ── Económico sectorial ──────────────────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('EconoJournal', 'https://econojournal.com.ar', 'sectorial', 'es')
ON CONFLICT DO NOTHING;

-- ── Centros de estudio ───────────────────────────────────────────────
INSERT INTO public.media_sources (name, url, category, language) VALUES
  ('CEPA', 'https://centrocepa.com.ar', 'centro_de_estudio', 'es'),
  ('MATE', 'https://fundacionmate.com.ar', 'centro_de_estudio', 'es')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Periodistas de análisis de referencia
-- Los artículos que mencionan estos nombres se marcan como "análisis"
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.journalists (name, media_outlet, topics, search_keywords) VALUES
  ('Juan Gabriel Tokatlian', 'varios', ARRAY['geopolítica','relaciones internacionales'], ARRAY['Tokatlian']),
  ('Diego Genoud', 'varios', ARRAY['política','peronismo'], ARRAY['Genoud']),
  ('Alfredo Zaiat', 'Página/12', ARRAY['economía','modelo económico'], ARRAY['Zaiat']),
  ('Raúl Kollmann', 'Página/12', ARRAY['política','inteligencia'], ARRAY['Kollmann']),
  ('Horacio Verbitsky', 'El Cohete a la Luna', ARRAY['política','DDHH','investigación'], ARRAY['Verbitsky']),
  ('Marcelo Zlotogwiazda', 'varios', ARRAY['economía'], ARRAY['Zlotogwiazda'])
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Schedules: 3 envíos diarios
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.digest_schedules (name, cron_expression, description, is_active) VALUES
  ('Resumen 07:00', '0 10 * * *', 'Resumen personal matutino (10 UTC = 07:00 ART)', true),
  ('Resumen 13:00', '0 16 * * *', 'Resumen personal de mediodía (16 UTC = 13:00 ART)', true),
  ('Boletín 20:00', '0 23 * * *', 'Boletín grupal nocturno (23 UTC = 20:00 ART)', true)
ON CONFLICT DO NOTHING;
