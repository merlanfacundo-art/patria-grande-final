import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Medios de análisis prioritarios ──────────────────────────────────────────
const ANALYSIS_SOURCE_NAMES = [
  'cenital', 'revista anfibia', 'anfibia', 'el cohete a la luna', 'panamá revista',
  'le monde diplomatique', 'revista crisis', 'crisis', 'cepa', 'mate',
  'diagonales', 'letra p', 'perspectiva sur', 'econojournal', 'va con firma',
  'kranear', 'el grito del sur',
];

// Periodistas de análisis: sus artículos siempre van al bucket análisis
const ANALYSIS_JOURNALIST_KEYWORDS = [
  'tokatlian', 'genoud', 'zaiat', 'kollmann', 'verbitsky', 'zlotogwiazda',
];

// ── TinyURL: acortador gratuito sin auth ──────────────────────────────────────
async function shortenUrl(url: string): Promise<string> {
  try {
    const res = await fetch(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return url;
    const short = (await res.text()).trim();
    return short.startsWith('http') ? short : url;
  } catch {
    return url; // fallback: URL original
  }
}

// Acorta un array de URLs en paralelo
async function shortenAll(urls: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    urls.map(async (url) => [url, await shortenUrl(url)] as [string, string])
  );
  return new Map(entries);
}

// ── Gemini: llamada directa a Google AI (sin gateway Lovable) ─────────────────
async function callGemini(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens = 4096
): Promise<{ text: string; finishReason: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens,
      // Gemini 2.5 Flash tiene "thinking mode" activado por defecto, que
      // consume tokens del budget sin aparecer en la salida. Lo desactivamos
      // para que todos los tokens vayan al mensaje visible.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Retry con backoff para errores temporales (503 overload, 429 rate limit)
  const maxAttempts = 4;
  const retryDelays = [1500, 4000, 9000]; // ms entre intentos

  let lastError = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN';
      return { text, finishReason };
    }

    const err = await res.text();
    lastError = `[${res.status}]: ${err}`;

    // Reintentar solo en errores temporales
    if (res.status === 503 || res.status === 429 || res.status >= 500) {
      if (attempt < maxAttempts - 1) {
        console.warn(`Gemini ${res.status}, reintentando en ${retryDelays[attempt]}ms (intento ${attempt + 1}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }
    }

    // Error definitivo (4xx no-429, o último intento fallido)
    throw new Error(`Gemini API error ${lastError}`);
  }

  throw new Error(`Gemini API error después de ${maxAttempts} intentos: ${lastError}`);
}

// ── Clasificación de artículos ────────────────────────────────────────────────
function classifyArticles(articles: any[]): { noticias: any[]; analisis: any[] } {
  const noticias: any[] = [];
  const analisis: any[] = [];

  for (const art of articles) {
    const source = art.media_sources as any;
    if (!source) continue;

    const srcName = (source.name || '').toLowerCase();
    const isAnalysisSrc = ANALYSIS_SOURCE_NAMES.some(s => srcName.includes(s))
      || ['centro_de_estudio', 'revista', 'analisis_politico'].includes(source.category);

    const hasAnalysisJournalist = art.journalist_id !== null;

    if (isAnalysisSrc || hasAnalysisJournalist) {
      analisis.push(art);
    } else {
      noticias.push(art);
    }
  }
  return { noticias, analisis };
}

// ── Prompt: resumen personal (07:00 / 13:00) ─────────────────────────────────
function buildPersonalSystemPrompt(): string {
  return `Sos el editor de inteligencia política de Patria Grande, una organización peronista y popular argentina.

Generás un *resumen político personal* para el responsable de comunicación de la organización.
Este resumen es EXTENSO, DETALLADO y de uso interno — no va al grupo.

REGLAS DE CONTENIDO:
- Lenguaje militante peronista, claro y directo.
- Perspectiva de género SIEMPRE: visibilizá cómo los temas impactan diferenciadamente en mujeres, LGBTIQ+ y disidencias. Si un tema no tiene dimensión de género, igual buscala.
- Puntuación en castellano correcta: usá ¡! y ¿? donde corresponda.
- Calidad alta: solo incluir noticias con al menos 2 fuentes distintas. Descartar noticias débiles.
- Todos los links YA ESTÁN ACORTADOS en la lista de artículos: usalos textualmente, no los modifiques.

REGLAS DE LONGITUD (CRÍTICO):
- El mensaje debe SIEMPRE cerrar con el footer "—\\n🤖 Patria Grande | [horario]".
- Si tenés mucho material, priorizá así:
  1. Panorama del día (obligatorio, corto).
  2. Top 3-5 temas nacionales más relevantes (no todos, los MÁS importantes).
  3. Top 2-3 temas internacionales con impacto para Argentina.
  4. Top 2 temas fuera de agenda.
  5. Análisis: TODAS las novedades de medios/periodistas definidos (prioridad absoluta).
  6. Comparación con envío anterior (corta).
  7. Footer de cierre (OBLIGATORIO).
- Si empezás a quedarte sin espacio, ACORTÁ las descripciones individuales (2 oraciones en vez de 4) antes que omitir secciones.
- NUNCA dejes el mensaje cortado a la mitad. Si ves que no entra todo, eliminá temas menos importantes, NO truncar un tema por la mitad.

ESTRUCTURA DEL RESUMEN PERSONAL:

*📋 RESUMEN [HORARIO] — [Día] [fecha]*

*🔗 PANORAMA DEL DÍA*
[2-3 oraciones que conecten todos los temas entre sí: qué tienen en común, qué hilo conductor los une, qué revela el conjunto sobre la coyuntura.]

*🇦🇷 ARGENTINA*
▪️ *[Título del tema]*
Descripción política, 2-3 oraciones. Quién gana, quién pierde, qué implica para el campo popular. Dimensión de género si aplica.
🔗 [link1] ([Medio1]) · [link2] ([Medio2]) · [link3] ([Medio3])

[Los TOP 3-5 temas nacionales más relevantes con 2+ fuentes. NO incluir todos, elegir los más importantes.]

*🌍 INTERNACIONAL*
▪️ *[Título]*
[Descripción, 2-3 oraciones, impacto para Argentina y la región]
🔗 [links]

[Top 2-3 temas internacionales con impacto regional/global]

*🔍 FUERA DE AGENDA*
▪️ *[Título]*
[Lo que los medios hegemónicos no priorizan pero es relevante para el campo popular, 2 oraciones]
🔗 [links]

[Top 2 temas fuera de agenda]

*📝 ANÁLISIS — NOVEDADES DESDE EL ÚLTIMO ENVÍO*
[Esta sección es OBLIGATORIA. Incluí MÁXIMO 12 notas. Priorizá en este orden: (1) notas de Cenital, Anfibia, El Cohete a la Luna, Panamá Revista, Revista Crisis — las más de fondo; (2) notas de Le Monde Diplomatique, CEPA, MATE; (3) notas de EconoJournal, Va con firma, Kranear, El Grito del Sur; (4) notas de periodistas como Tokatlian, Genoud, Zaiat, Verbitsky, Kollmann, Zlotogwiazda. Si hay más de 12 notas, elegí las 12 más relevantes siguiendo esta prioridad. Cada nota con 1-2 oraciones MÁXIMO.]
▪️ *[Título de la nota]* — [Medio/Periodista]
[Resumen breve del enfoque, 1-2 oraciones. Por qué es importante para la organización.]
🔗 [link exacto acortado]

*📊 COMPARACIÓN CON ENVÍO ANTERIOR*
[Qué temas se actualizaron, cuáles son nuevos, cuáles desaparecieron. 3-4 líneas máximo.]

—
🤖 Patria Grande | [horario]

⚠️ RECORDATORIO FINAL (CRITICO): El mensaje SIEMPRE debe terminar con la línea "🤖 Patria Grande | [horario]". Si llegás al límite de tokens sin cerrar, REINICIÁ con menos contenido: cortá 3 notas de análisis, acortá descripciones, eliminá la sección "COMPARACIÓN" si hace falta. NUNCA entregues un mensaje sin cerrar. Antes de terminar, verificá que el footer está presente.`;
}

// ── Prompt: boletín grupal (20:00) ───────────────────────────────────────────
function buildGroupSystemPrompt(): string {
  return `Sos el editor del boletín político de Patria Grande, una organización peronista y popular argentina.

Generás el *boletín grupal nocturno* para enviar a un grupo de WhatsApp con simpatizantes de contexto político medio.
El boletín se va a COPIAR Y PEGAR en WhatsApp desde Telegram.

REGLAS CRÍTICAS:
- EXTENSIÓN: 300-400 palabras en total. No más. Es para leer en el celular en 2 minutos.
- Lenguaje militante pero ACCESIBLE: sin jerga interna, sin dar nada por sabido.
- Perspectiva de género SIEMPRE: visibilizá impactos diferenciados en mujeres, LGBTIQ+ y disidencias.
- Puntuación castellana correcta: ¡! y ¿? donde corresponda.
- Calidad alta: máximo 2 temas nacionales, 1 internacional, 1 fuera de agenda, 2-3 análisis.
- Solo incluir noticias con 2+ fuentes. Descartar noticias sin respaldo.
- Todos los links YA ESTÁN ACORTADOS: usalos textualmente.
- Los links van al FINAL de cada ítem, no en el medio del texto.
- Cada ítem DEBE tener contexto explicativo: qué pasó Y por qué importa para la gente común.

ESTRUCTURA EXACTA (respetá emojis, separadores y orden):

🗞️ *PATRIA GRANDE — Resumen político*
📅 [Día] [fecha larga: ej. "Miércoles 22 de abril de 2025"]

━━━━━━━━━━━━━━━━━
🔗 LOS TEMAS DE HOY
━━━━━━━━━━━━━━━━━
[2-3 oraciones que conecten todos los temas. Qué hilo conductor los une. Tono político claro.]

━━━━━━━━━━━━━━━━━
🇦🇷 ARGENTINA
━━━━━━━━━━━━━━━━━
▪️ *[Título accesible — sin tecnicismos]*
[2-3 oraciones: qué pasó + por qué le importa a la gente. Incluir dimensión de género si aplica.]
🔗 [link1] ([Medio1]) · [link2] ([Medio2])

▪️ *[Segundo tema nacional]*
[ídem]
🔗 [links]

━━━━━━━━━━━━━━━━━
🌍 EL MUNDO
━━━━━━━━━━━━━━━━━
▪️ *[Tema internacional relevante para Argentina/la región]*
[2 oraciones: qué pasó + conexión con Argentina o el campo popular regional]
🔗 [links]

━━━━━━━━━━━━━━━━━
🔍 LO QUE LA CORPORACIÓN MEDIÁTICA OCULTA
━━━━━━━━━━━━━━━━━
▪️ *[Tema fuera de la agenda hegemónica]*
[2 oraciones: qué es + por qué los medios dominantes no lo muestran]
🔗 [links]

━━━━━━━━━━━━━━━━━
📖 PARA PROFUNDIZAR
━━━━━━━━━━━━━━━━━
▪️ *[Título]* — [Medio]
[1 oración sobre el enfoque]
🔗 [link]

▪️ *[Título]* — [Medio]
[1 oración]
🔗 [link]

━━━━━━━━━━━━━━━━━
✌️🇦🇷 *Patria Grande* | [fecha corta: ej. "22/04"] — 20:00`;
}

// ── Handler principal ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurado');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const body = await req.json().catch(() => ({}));
    // digest_type: 'personal' | 'group'
    const digestType: 'personal' | 'group' = body.digest_type || 'group';
    const scheduleName: string = body.schedule_name || 'Manual';

    // ── 1. Obtener artículos de las últimas 24hs ──────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: articles, error: artErr } = await supabase
      .from('scraped_articles')
      .select('*, media_sources(name, category, language)')
      .gte('scraped_at', since)
      .order('scraped_at', { ascending: false })
      .limit(200);

    if (artErr) throw artErr;
    if (!articles || articles.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'Sin artículos en las últimas 24hs' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Obtener último digest grupal para contexto/dedup/aprendizaje ───────
    const { data: lastDigest } = await supabase
      .from('digest_sends')
      .select('telegram_message, created_at, learning_notes')
      .eq('status', 'sent')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const lastMessage = lastDigest?.telegram_message || '';
    const lastSentAt = lastDigest?.created_at ? new Date(lastDigest.created_at) : null;
    const lastLearning = lastDigest?.learning_notes || '';

    // ── 3. Deduplicar por URL usada en el último mensaje ──────────────────────
    const freshArticles = articles.filter((a: any) => !lastMessage.includes(a.url));
    const articlesToUse = freshArticles.length >= 3 ? freshArticles : articles;

    // Artículos nuevos desde el último envío (para análisis personal)
    const novelArticles = lastSentAt
      ? articlesToUse.filter((a: any) => new Date(a.scraped_at) > lastSentAt)
      : articlesToUse;

    // ── 4. Clasificar en noticias / análisis ──────────────────────────────────
    const { noticias, analisis } = classifyArticles(articlesToUse);

    if (noticias.length === 0 && analisis.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'Sin artículos categorizables' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 5. Acortar todos los URLs de una vez (batch, gratuito vía TinyURL) ────
    const allUrls = articlesToUse.map((a: any) => a.url).filter(Boolean);
    const shortUrlMap = await shortenAll(allUrls);

    // Reemplazar URLs en los artículos con sus versiones acortadas
    const withShortUrls = articlesToUse.map((a: any) => ({
      ...a,
      url_short: shortUrlMap.get(a.url) || a.url,
    }));
    const noticiasShort = withShortUrls.filter((a: any) =>
      noticias.some((n: any) => n.id === a.id)
    );
    const analisisShort = withShortUrls.filter((a: any) =>
      analisis.some((n: any) => n.id === a.id)
    );
    const novelAnalisisShort = withShortUrls.filter((a: any) =>
      novelArticles.some((n: any) => n.id === a.id) &&
      analisis.some((n: any) => n.id === a.id)
    );

    // ── 6. Construir el contexto para el prompt ────────────────────────────────
    const formatArticleList = (arts: any[], label: string, limit = 50) => {
      if (arts.length === 0) return '';
      const lines = arts.slice(0, limit).map((a: any) => {
        const src = a.media_sources as any;
        return `- "${a.title}" | ${src?.name || '?'} | ${a.url_short}\n  Resumen: ${(a.summary || '').substring(0, 250)}`;
      }).join('\n');
      return `## ${label} (${arts.length})\n${lines}`;
    };

    const articlesContext = [
      formatArticleList(noticiasShort, 'NOTICIAS', digestType === 'personal' ? 80 : 40),
      formatArticleList(analisisShort, 'ANÁLISIS Y PERIODISTAS', digestType === 'personal' ? 40 : 20),
    ].filter(Boolean).join('\n\n');

    const novelContext = novelAnalisisShort.length > 0
      ? `\n\n## NOVEDADES DE ANÁLISIS DESDE EL ÚLTIMO ENVÍO (incluir TODAS en sección Análisis)\n` +
        novelAnalisisShort.map((a: any) => {
          const src = a.media_sources as any;
          return `- "${a.title}" | ${src?.name || '?'} | ${a.url_short}`;
        }).join('\n')
      : '';

    const previousContext = lastMessage
      ? `\n\n## ÚLTIMO BOLETÍN ENVIADO (para continuidad, dedup y comparación)\n${lastMessage.substring(0, 2000)}`
      : '';

    const learningContext = lastLearning
      ? `\n\n## APRENDIZAJES DEL CICLO ANTERIOR (aplicar para mejorar este envío)\n${lastLearning}`
      : '';

    const allowedUrlsBlock = `\n\n## URLs PERMITIDAS (solo estas, textuales, ya acortadas)\n${
      withShortUrls.map((a: any) => a.url_short).filter(Boolean).join('\n')
    }`;

    // Formatear fecha y hora actual en zona horaria de Argentina (UTC-3)
    const nowArgentina = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const dayName = dayNames[nowArgentina.getUTCDay()];
    const dayNum = nowArgentina.getUTCDate();
    const monthName = monthNames[nowArgentina.getUTCMonth()];
    const year = nowArgentina.getUTCFullYear();
    const dateLong = `${dayName} ${dayNum} de ${monthName} de ${year}`;
    const dateShort = `${String(dayNum).padStart(2, '0')}/${String(nowArgentina.getUTCMonth() + 1).padStart(2, '0')}`;

    const userPrompt = `Generá el ${digestType === 'personal' ? 'resumen personal' : 'boletín grupal'} "${scheduleName}".

FECHA ACTUAL (usar SIEMPRE esta fecha, NO inventar otra):
- Fecha larga: ${dateLong}
- Fecha corta: ${dateShort}

${articlesContext}${novelContext}${previousContext}${learningContext}${allowedUrlsBlock}

RECORDATORIO CRÍTICO:
- Usá ÚNICAMENTE las URLs de la lista "URLs PERMITIDAS". Nunca inventar links ni usar homepages.
- Todos los links ya están acortados (tinyurl). Usalos textualmente.
- ${digestType === 'personal'
    ? 'Incluir TODAS las novedades de análisis desde el último envío.'
    : 'Máximo 2 nacionales + 1 internacional + 1 fuera de agenda + 2-3 análisis. 300-400 palabras total.'}
- Perspectiva de género siempre.
- Puntuación castellana: ¡! y ¿? donde corresponda.
- Usá la fecha exacta que está arriba. NO generes una fecha distinta.`;

    // ── 7. Llamar a Gemini ────────────────────────────────────────────────────
    const systemPrompt = digestType === 'personal'
      ? buildPersonalSystemPrompt()
      : buildGroupSystemPrompt();

    // Resumen personal = más largo (hasta 16384 tokens ≈ 10000 palabras)
    // Boletín grupal = target 300-400 palabras, pero reservamos 8192 tokens
    // porque Gemini 2.5 Flash consume tokens en "pensamiento" interno que no
    // se ve en la salida. Con 4096 se truncaba.
    const maxTokens = digestType === 'personal' ? 16384 : 8192;

    const { text: digestMessage, finishReason } = await callGemini(
      GEMINI_API_KEY, systemPrompt, userPrompt, maxTokens
    );

    if (!digestMessage) throw new Error('Gemini devolvió respuesta vacía');

    if (finishReason === 'MAX_TOKENS') {
      console.warn(`[${scheduleName}] Gemini llegó al límite de tokens (${maxTokens}). El mensaje puede estar truncado.`);
    }

    // ── 8. Guardar en DB solo si es boletín grupal ────────────────────────────
    if (digestType === 'group') {
      // Pedir a Gemini que genere notas de aprendizaje para el próximo ciclo
      const learningPrompt = `Analizás este boletín político que acabás de generar y el anterior.
Boletín anterior:\n${lastMessage.substring(0, 1000)}
Boletín nuevo:\n${digestMessage.substring(0, 1000)}

Generá 3-5 notas de aprendizaje CONCRETAS y BREVES sobre:
- Qué mejoró respecto al anterior
- Qué podría ser mejor en el próximo
- Qué formato/enfoque funcionó mejor
- Algún tema de género que se podría haber profundizado más

Formato: lista con guiones. Máximo 300 palabras en total.`;

      let learningNotes = '';
      try {
        const { text } = await callGemini(
          GEMINI_API_KEY,
          'Sos un editor crítico de boletines políticos. Respondé solo en castellano rioplatense.',
          learningPrompt,
          1024
        );
        learningNotes = text;
      } catch {
        learningNotes = 'Sin notas de aprendizaje generadas en este ciclo.';
      }

      const { data: digest, error: digestErr } = await supabase
        .from('digest_sends')
        .insert({
          telegram_message: digestMessage,
          articles_count: articlesToUse.length,
          status: 'pending',
          learni