import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─────────────────────────────────────────────────────────────────────────────
// Estrategia: Google News RSS como primario (gratis, sin límites),
// Firecrawl como fallback (free tier, solo cuando RSS < 2 resultados).
// ─────────────────────────────────────────────────────────────────────────────

const FIRECRAWL_API_URL = 'https://api.firecrawl.dev';
const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const getTag = (tag: string): string => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
      const m = block.match(re);
      return m ? m[1].trim() : '';
    };
    const title = getTag('title').replace(/<[^>]+>/g, '').trim();
    const link = getTag('link').trim();
    const description = getTag('description').replace(/<[^>]+>/g, '').trim();
    const pubDate = getTag('pubDate');
    if (title && link) items.push({ title, link, description, pubDate });
  }
  return items;
}

function unwrapGoogleNewsUrl(url: string): string {
  try {
    const u = new URL(url);
    const realUrl = u.searchParams.get('url');
    return realUrl || url;
  } catch {
    return url;
  }
}

async function scrapeViaGoogleNewsRSS(source: any, maxItems = 5): Promise<any[]> {
  try {
    const hostname = new URL(source.url).hostname.replace(/^www\./, '');
    const query = `site:${hostname}+when:1d`;
    const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=es-419&gl=AR&ceid=AR:es-419`;
    const res = await fetchWithTimeout(url, {}, 12000);
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRss(xml).slice(0, maxItems);
    return items.map(item => ({
      url: unwrapGoogleNewsUrl(item.link),
      title: item.title,
      description: item.description,
      pubDate: item.pubDate,
    }));
  } catch (e) {
    console.error(`Google News RSS falló para ${source.name}:`, e);
    return [];
  }
}

async function scrapeViaFirecrawl(source: any, apiKey: string, maxItems = 5): Promise<any[]> {
  try {
    const hostname = new URL(source.url).hostname;
    const res = await fetchWithTimeout(
      `${FIRECRAWL_API_URL}/v1/search`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `site:${hostname} noticias hoy`, limit: maxItems, tbs: 'qdr:d' }),
      },
      15000
    );
    if (!res.ok) return [];
    const data = await res.json();
    const articles = data.data || [];
    return articles.map((a: any) => ({
      url: a.url,
      title: a.title,
      description: a.description || (a.markdown || '').substring(0, 300),
      markdown: a.markdown,
    }));
  } catch (e) {
    console.error(`Firecrawl falló para ${source.name}:`, e);
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const MAX_RUNTIME_MS = 50_000;

  try {
    const FIRECRAWL_API_KEY = Deno.env.get('FIRECRAWL_API_KEY');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: sources, error: srcErr } = await supabase
      .from('media_sources').select('*').eq('is_active', true);
    if (srcErr) throw srcErr;

    const { data: journalists } = await supabase
      .from('journalists').select('*').eq('is_active', true);

    const { data: configRows } = await supabase.from('digest_config').select('*');
    const config: Record<string, string> = {};
    configRows?.forEach((r: any) => { config[r.key] = r.value; });

    const parseKw = (s: string) => (s || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const graboisKw = parseKw(config.grabois_keywords || 'Grabois,Patria Grande');
    const argKw = parseKw(config.argentina_keywords || 'Argentina,argentino');
    const genderKw = parseKw(config.gender_keywords || 'mujeres,género,feminismo');

    let totalScraped = 0;
    let viaRss = 0;
    let viaFirecrawl = 0;
    const errors: string[] = [];
    const skipped: string[] = [];

    const BATCH_SIZE = 10;
    for (let i = 0; i < (sources?.length || 0); i += BATCH_SIZE) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        skipped.push(...sources!.slice(i).map((s: any) => s.name));
        break;
      }
      const batch = sources!.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (source: any) => {
          try {
            let articles = await scrapeViaGoogleNewsRSS(source, 5);
            let method: 'rss' | 'firecrawl' = 'rss';

            if (articles.length < 2 && FIRECRAWL_API_KEY) {
              const fcArts = await scrapeViaFirecrawl(source, FIRECRAWL_API_KEY, 5);
              if (fcArts.length > articles.length) {
                articles = fcArts;
                method = 'firecrawl';
              }
            }

            if (articles.length === 0) {
              errors.push(`${source.name}: sin resultados`);
              return 0;
            }

            let count = 0;
            for (const article of articles) {
              if (!article.url || !article.title) continue;
              const combined = `${article.title} ${article.description || ''} ${article.markdown || ''}`.toLowerCase();
              const isAboutGrabois = graboisKw.some(k => combined.includes(k));
              const isAboutArgentina = argKw.some(k => combined.includes(k));
              const hasGenderAngle = genderKw.some(k => combined.includes(k));

              let journalistId: string | null = null;
              if (journalists) {
                for (const j of journalists) {
                  const keywords: string[] = j.search_keywords || [];
                  if (keywords.some((kw: string) => combined.includes(kw.toLowerCase()))) {
                    journalistId = j.id;
                    break;
                  }
                }
              }

              const summary = (article.description || (article.markdown || '').substring(0, 300)).trim();

              const { error: insertErr } = await supabase
                .from('scraped_articles')
                .upsert({
                  source_id: source.id,
                  title: article.title,
                  url: article.url,
                  summary,
                  content_markdown: (article.markdown || '').substring(0, 5000),
                  language: source.language,
                  is_about_argentina: isAboutArgentina,
                  is_about_grabois: isAboutGrabois,
                  has_gender_angle: hasGenderAngle,
                  journalist_id: journalistId,
                  scraped_at: new Date().toISOString(),
                }, { onConflict: 'url' });

              if (!insertErr) count++;
            }

            if (method === 'rss') viaRss += count;
            else viaFirecrawl += count;

            console.log(`${source.name} (${method}): ${count} artículos`);
            return count;
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Unknown';
            errors.push(`${source.name}: ${msg}`);
            return 0;
          }
        })
      );

      results.forEach(r => {
        if (r.status === 'fulfilled') totalScraped += r.value;
      });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`Scrape completo: ${totalScraped} (${viaRss} RSS, ${viaFirecrawl} Firecrawl) en ${elapsed}s`);

    return new Response(
      JSON.stringify({
        success: true,
        scraped: totalScraped,
        via_rss: viaRss,
        via_firecrawl: viaFirecrawl,
        sources: sources?.length,
        errors,
        skipped,
        elapsed_seconds: elapsed,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error scrape:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
