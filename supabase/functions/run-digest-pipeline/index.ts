// Orquestador del pipeline completo: scrape → generate → send
// 07:00 → resumen personal (no se guarda en DB, va directo a Telegram de Facu)
// 13:00 → resumen personal (ídem)
// 20:00 → boletín grupal (se guarda en DB, va automático al grupo de Telegram)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SCHEDULE_CONFIG: Record<string, { digestType: 'personal' | 'group'; label: string }> = {
  'Resumen 07:00': { digestType: 'personal', label: '07:00' },
  'Resumen 13:00': { digestType: 'personal', label: '13:00' },
  'Boletín 20:00': { digestType: 'group',    label: '20:00' },
  'Manual':        { digestType: 'group',    label: 'Manual' },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const body = await req.json().catch(() => ({}));
    const scheduleName: string = body.schedule_name || 'Manual';
    const config = SCHEDULE_CONFIG[scheduleName] || SCHEDULE_CONFIG['Manual'];

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    const callFn = async (name: string, payload: any, timeoutMs = 55000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        return await res.json();
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          return { success: false, error: `${name} timeout` };
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };

    console.log(`[${scheduleName}] Iniciando pipeline — tipo: ${config.digestType}`);

    // ── Paso 1: Scraping ──────────────────────────────────────────────────────
    console.log(`[${scheduleName}] Paso 1: scrapeando noticias...`);
    const scrapeData = await callFn('scrape-news', {});
    console.log(`[${scheduleName}] Scrape: ${scrapeData.scraped || 0} artículos, ${scrapeData.errors?.length || 0} errores`);

    // ── Paso 2: Generar digest ────────────────────────────────────────────────
    console.log(`[${scheduleName}] Paso 2: generando ${config.digestType}...`);
    const digestData = await callFn('generate-digest', {
      schedule_name: scheduleName,
      digest_type: config.digestType,
    });

    if (!digestData.success) {
      console.log(`[${scheduleName}] Sin digest: ${digestData.message || digestData.error}`);
      return new Response(
        JSON.stringify({
          success: true,
          message: digestData.message || 'Sin artículos para generar digest',
          step: 'generate',
          scrape: scrapeData,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Paso 3: Enviar por Telegram ───────────────────────────────────────────
    console.log(`[${scheduleName}] Paso 3: enviando por Telegram...`);
    let sendData: any;

    if (config.digestType === 'personal') {
      // Resúmenes personales: el mensaje viene en la respuesta del generate, se envía directo
      // al chat personal de Facu (no se guarda en DB)
      const personalChatId = Deno.env.get('TELEGRAM_PERSONAL_CHAT_ID');
      if (!personalChatId) {
        console.warn('TELEGRAM_PERSONAL_CHAT_ID no configurado — resumen personal no enviado');
        return new Response(
          JSON.stringify({
            success: false,
            error: 'TELEGRAM_PERSONAL_CHAT_ID no configurado',
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      sendData = await callFn('send-telegram', {
        message: digestData.message,
        chat_id: personalChatId,
      });
    } else {
      // Boletín grupal: el digest ya está guardado en DB con status 'pending'
      sendData = await callFn('send-telegram', {
        digest_id: digestData.digest_id,
      });
    }

    console.log(`[${scheduleName}] Envío: ${sendData.success ? 'OK' : 'FALLO'}`);

    return new Response(
      JSON.stringify({
        success: true,
        schedule: scheduleName,
        digest_type: config.digestType,
        scraped: scrapeData.scraped || 0,
        articles_in_digest: digestData.articles_count || 0,
        noticias: digestData.noticias_count || 0,
        analisis: digestData.analisis_count || 0,
        telegram_sent: sendData.success || false,
        novel_analysis: digestData.novel_analysis_count || 0,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error pipeline:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
