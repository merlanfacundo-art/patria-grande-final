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
): Promise<{ text: string; finishReason: string; modelUsed: string }> {
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

  // Cascada de modelos: si uno está saturado, probamos el siguiente.
  // Ordenados de mejor calidad a más disponibilidad (más RPM/RPD). Free tier.
  // Verificado en abril 2026: 1.5-flash descontinuado, 2.0-flash deprecado.
  const models = [
    'gemini-2.5-flash',       // primario: 10 RPM, 250 RPD
    'gemini-2.5-flash-lite',  // fallback: 15 RPM, 1000 RPD (mayor disponibilidad)
    'gemini-2.5-pro',         // último recurso: 5 RPM pero más potente
  ];

  // Por modelo: 4 intentos con backoff (total ~25s por modelo)
  const retryDelays = [1500, 4000, 8000];

  let lastError = '';

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN';
        if (model !== models[0] || attempt > 0) {
          console.log(`Gemini OK con modelo ${model} (intento ${attempt + 1})`);
        }
        return { text, finishReason, modelUsed: model };
      }

      const err = await res.text();
      lastError = `${model} [${res.status}]: ${err.substring(0, 200)}`;

      // Errores temporales: reintentar con el mismo modelo
      const isTransient = res.status === 503 || res.status === 429 || res.status >= 500;

      if (isTransient && attempt < 3) {
        console.warn(`${model} ${res.status}, reintentando en ${retryDelays[attempt]}ms (intento ${attempt + 1}/4)...`);
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }

      // Si es error 4xx (no recuperable) o se agotaron los retries de este modelo,
      // pasar al siguiente modelo de la cascada.
      if (!isTransient) {
        console.error(`${model} error definitivo ${res.status}, no se reintenta`);
      } else {
        console.warn(`${model} agotó retries, pasando al siguiente modelo de la cascada`);
      }
      break;
    }
  }

  throw new Error(`Gemini API error - todos los modelos fallaron. Último: ${lastError}`);
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
- Perspectiva de género NATURAL: cuando un tema tiene dimensión de género real (afecta diferenciadamente a mujeres, LGBTIQ+ y disidencias, o los involucra como protagonistas), incluirla con claridad. Cuando un tema NO tiene esa dimensión (ej: política internacional general, decisiones macroeconómicas estructurales que afectan a toda la población), NO la fuerces. Es preferible omitirla a inventarla. La perspectiva de género se nota en QUÉ noticias se eligen y cómo se cuentan, no en agregar una frase forzada al final de cada tema.
- Puntuación en castellano correcta: usá ¡! y ¿? donde corresponda.
- Calidad alta: solo incluir noticias con al menos 2 fuentes distintas. Descartar noticias débiles.
- Todos los links YA ESTÁN ACORTADOS en la lista de artículos: usalos textualmente, no los modifiques.

REGLAS DE LONGITUD (CRÍTICO):
- El mensaje debe SIEMPRE cerrar con el footer "—\\n🤖 Patria Grande | [horario]".
- Si tenés mucho material, priorizá así:
  1. Panorama del día (obligatorio, corto).
  2. Top 3-5 temas nacionales más relevantes (no todos, los MÁS importantes).
  3. Top 3-4 temas internacionales (mezcla obligatoria: 1-2 de alto impacto global + 1-2 regionales).
  4. Top 2 temas fuera de agenda.
  5. Análisis: TODAS las novedades de medios/periodistas definidos (prioridad absoluta).
  6. Comparación con envío anterior (corta).
  7. Footer de cierre (OBLIGATORIO).
- Si empezás a quedarte sin espacio, ACORTÁ las descripciones individuales (2 oraciones en vez de 4) antes que omitir secciones.
- NUNCA dejes el mensaje cortado a la mitad. Si ves que no entra todo, eliminá temas menos importantes, NO truncar un tema por la mitad.

ESTRUCTURA DEL RESUMEN PERSONAL (respetá EXACTAMENTE los separadores ━━━ con sus saltos de línea):

📋 *RESUMEN [HORARIO] — [Día] [fecha]*

━━━━━━━━━━━━━━━━━
🔗 PANORAMA DEL DÍA
━━━━━━━━━━━━━━━━━
[2-3 oraciones que conecten todos los temas entre sí: qué tienen en común, qué hilo conductor los une, qué revela el conjunto sobre la coyuntura.]

━━━━━━━━━━━━━━━━━
🇦🇷 ARGENTINA
━━━━━━━━━━━━━━━━━
▪️ *[Título del tema]*
Descripción política, 2-3 oraciones. Quién gana, quién pierde, qué implica para el campo popular. Dimensión de género si aplica.
🔗 [link1] ([Medio1]) · [link2] ([Medio2]) · [link3] ([Medio3])

[Los TOP 3-5 temas nacionales más relevantes con 2+ fuentes. NO incluir todos, elegir los más importantes.]

━━━━━━━━━━━━━━━━━
🌍 INTERNACIONAL
━━━━━━━━━━━━━━━━━
▪️ *[Título]*
[Descripción, 2-3 oraciones]
🔗 [links]

[Top 3-4 temas internacionales. INCLUIR OBLIGATORIAMENTE eventos de ALTO IMPACTO GLOBAL aunque NO toquen directamente a Argentina: atentados políticos, elecciones en potencias, conflictos bélicos, decisiones del FMI/BM/G20, cumbres internacionales, crisis institucionales en EEUU/UE/China/Rusia. Junto con esos, también incluir 1-2 temas con impacto en Argentina o América Latina: situación en países hermanos, integración regional, luchas populares latinoamericanas. La distancia ideológica con un actor político no es razón para omitir un evento mayor que lo involucre — lo cubrimos desde nuestra perspectiva crítica.]

━━━━━━━━━━━━━━━━━
🔍 FUERA DE AGENDA
━━━━━━━━━━━━━━━━━
▪️ *[Título]*
[Lo que los medios hegemónicos no priorizan pero es relevante para el campo popular, 2 oraciones]
🔗 [links]

[Top 2 temas fuera de agenda]

━━━━━━━━━━━━━━━━━
📝 ANÁLISIS — NOVEDADES DESDE EL ÚLTIMO ENVÍO
━━━━━━━━━━━━━━━━━
[Esta sección es OBLIGATORIA. Incluí MÁXIMO 12 notas. Priorizá en este orden: (1) notas de Cenital, Anfibia, El Cohete a la Luna, Panamá Revista, Revista Crisis — las más de fondo; (2) notas de Le Monde Diplomatique, CEPA, MATE; (3) notas de EconoJournal, Va con firma, Kranear, El Grito del Sur; (4) notas de periodistas como Tokatlian, Genoud, Zaiat, Verbitsky, Kollmann, Zlotogwiazda. Si hay más de 12 notas, elegí las 12 más relevantes siguiendo esta prioridad. Cada nota con 1-2 oraciones MÁXIMO.]
▪️ *[Título de la nota]* — [Medio/Periodista]
[Resumen breve del enfoque, 1-2 oraciones. Por qué es importante para la organización.]
🔗 [link exacto acortado]

━━━━━━━━━━━━━━━━━
📊 COMPARACIÓN CON ENVÍO ANTERIOR
━━━━━━━━━━━━━━━━━
[Qué temas se actualizaron, cuáles son nuevos, cuáles desaparecieron. 3-4 líneas máximo.]

━━━━━━━━━━━━━━━━━
✌️🇦🇷 *Patria Grande* | [fecha corta: ej. "24/04"] — [horario]

⚠️ RECORDATORIO FINAL (CRITICO): El mensaje SIEMPRE debe terminar con la línea "✌️🇦🇷 *Patria Grande* | [fecha corta] — [horario]". Si llegás al límite de tokens sin cerrar, REINICIÁ con menos contenido: cortá 3 notas de análisis, acortá descripciones, eliminá la sección "COMPARACIÓN" si hace falta. NUNCA entregues un mensaje sin cerrar. Antes de terminar, verificá que el footer está presente.`;
}

// ── Prompt: boletín grupal (20:00) ───────────────────────────────────────────
function buildGroupSystemPrompt(): string {
  return `Sos el editor del boletín político de Patria Grande, una organización peronista y popular argentina.

Generás el *boletín grupal nocturno* para enviar a un grupo de WhatsApp con simpatizantes de contexto político medio.
El boletín se va a COPIAR Y PEGAR en WhatsApp desde Telegram.

REGLAS CRÍTICAS:
- EXTENSIÓN: 400-500 palabras en total. Es para leer en el celular en 2-3 minutos.
- Lenguaje militante pero ACCESIBLE: sin jerga interna, sin dar nada por sabido.
- Perspectiva de género NATURAL: incluila cuando el tema tiene dimensión de género real (afecta diferenciadamente a mujeres, LGBTIQ+ y disidencias, o los involucra como protagonistas). Cuando el tema NO tiene esa dimensión, NO la fuerces. Es mejor omitirla que inventar una conexión rebuscada. Se nota en qué noticias se eligen y cómo se cuentan, no en agregar una frase forzada al final.
- Puntuación castellana correcta: ¡! y ¿? donde corresponda.
- Calidad alta: máximo 2 temas nacionales, 2 internacionales (uno global + uno regional), 1 de Quilmes, 1 fuera de agenda, 2 análisis.
- Solo incluir noticias con 2+ fuentes. Descartar noticias sin respaldo. EXCEPCIÓN: la noticia de Quilmes puede tener 1 sola fuente local (InfoQuilmes, Inforegión).
- Todos los links YA ESTÁN ACORTADOS: usalos textualmente.
- Los links van al FINAL de cada ítem, no en el medio del texto.
- DESCRIPCIONES BREVES: 2 oraciones máximo por tema. Que sean concisas y filosas, no largas y descriptivas.
- Cada ítem DEBE explicar: qué pasó Y por qué importa.

ESTRUCTURA EXACTA (respetá emojis, separadores y orden):

🗞️ *PATRIA GRANDE — Resumen político*
📅 [Día] [fecha larga: ej. "Miércoles 22 de abril de 2025"]

━━━━━━━━━━━━━━━━━
🔗 LOS TEMAS DE HOY
━━━━━━━━━━━━━━━━━
[2-3 oraciones que conecten los temas principales. Qué hilo conductor los une. Tono político claro.]

━━━━━━━━━━━━━━━━━
🇦🇷 ARGENTINA
━━━━━━━━━━━━━━━━━
▪️ *[Título accesible — sin tecnicismos]*
[2 oraciones: qué pasó + por qué le importa a la gente. Sumar dimensión de género solo si el tema lo tiene de forma natural.]
🔗 [link1] ([Medio1]) · [link2] ([Medio2])

▪️ *[Segundo tema nacional]*
[ídem, 2 oraciones]
🔗 [links]

━━━━━━━━━━━━━━━━━
🌍 EL MUNDO
━━━━━━━━━━━━━━━━━
▪️ *[Tema internacional de alto impacto global]*
[2 oraciones: qué pasó + por qué importa, incluso si NO toca directamente a Argentina. Por ejemplo: atentados políticos relevantes, elecciones en potencias, conflictos bélicos, decisiones del FMI o BM, cumbres internacionales, eventos en EEUU/UE/China/Rusia. Si hay un evento mundial mayor, va acá obligatoriamente, aun si la cobertura es desde perspectiva crítica.]
🔗 [links]

▪️ *[Tema internacional con impacto en Argentina o América Latina]*
[2 oraciones: qué pasó + conexión con Argentina, la región o el campo popular regional. Por ejemplo: situaciones políticas en países hermanos, integración regional, crisis económicas en países vecinos, luchas populares en Latinoamérica.]
🔗 [links]

━━━━━━━━━━━━━━━━━
📍 QUILMES
━━━━━━━━━━━━━━━━━
▪️ *[Una sola noticia relevante de Quilmes / sur GBA]*
[1-2 oraciones: qué pasó + por qué le interesa a vecinos y vecinas. Tema de política municipal, conflictos locales, gestión, organización barrial. Si en el día no hay nada relevante de Quilmes, omitir la sección entera (no inventar, no rellenar con un tema menor).]
🔗 [link] ([Medio: InfoQuilmes / Inforegión / otro local])

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
    // digest_type: 'personal' | 'group' | 'weekly'
    const digestType: 'personal' | 'group' | 'weekly' = body.digest_type || 'group';
    const scheduleName: string = body.schedule_name || 'Manual';

    // ── Rama: boletín semanal (sábados 10:00) ─────────────────────────────────
    // Lógica completamente separada del flujo diario. NO modifica nada del
    // pipeline de personal/group.
    if (digestType === 'weekly') {
      return await handleWeeklyDigest(supabase, GEMINI_API_KEY, scheduleName);
    }

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
- Perspectiva de género donde aplique naturalmente.
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

    const { text: digestMessage, finishReason, modelUsed } = await callGemini(
      GEMINI_API_KEY, systemPrompt, userPrompt, maxTokens
    );

    if (!digestMessage) throw new Error('Gemini devolvió respuesta vacía');

    if (finishReason === 'MAX_TOKENS') {
      console.warn(`[${scheduleName}] Gemini llegó al límite de tokens (${maxTokens}). El mensaje puede estar truncado.`);
    }

    console.log(`[${scheduleName}] Modelo usado: ${modelUsed}`);

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
          learning_notes: learningNotes,
        })
        .select()
        .single();

      if (digestErr) throw digestErr;

      return new Response(
        JSON.stringify({
          success: true,
          digest_id: digest.id,
          digest_type: 'group',
          articles_count: articlesToUse.length,
          noticias_count: noticias.length,
          analisis_count: analisis.length,
          message_length: digestMessage.length,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Resumen personal: solo devolver el mensaje, no guardar en DB ──────────
    return new Response(
      JSON.stringify({
        success: true,
        digest_type: 'personal',
        message: digestMessage,
        articles_count: articlesToUse.length,
        noticias_count: noticias.length,
        analisis_count: analisis.length,
        novel_analysis_count: novelAnalisisShort.length,
        message_length: digestMessage.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generate-digest:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MÓDULO: BOLETÍN SEMANAL (sábados 10:00 ART)
// ═════════════════════════════════════════════════════════════════════════════
// Estructura: 5 áreas de trabajo de Patria Grande Quilmes × 3 niveles cada una.
// Áreas: Cultura, Educación, Salud, Género, Brigadas Solidarias.
// Niveles: Nacional, Provincial (Buenos Aires), Municipal (Quilmes).
// Ventana: 7 días.
// Generación: 2 llamadas a Gemini en paralelo, después se concatenan.

interface AreaConfig {
  emoji: string;
  nombre: string;
  descripcion: string;
}

const AREAS: AreaConfig[] = [
  {
    emoji: '🎭',
    nombre: 'CULTURA',
    descripcion: 'política cultural, financiamiento, instituciones, festivales, espacios culturales, industrias culturales, libros, cine, música, teatro, patrimonio',
  },
  {
    emoji: '📚',
    nombre: 'EDUCACIÓN',
    descripcion: 'educación pública, presupuesto, paritarias docentes, universidades, escuelas, infancias, conflictos gremiales del sector, leyes educativas',
  },
  {
    emoji: '🏥',
    nombre: 'SALUD',
    descripcion: 'salud pública, hospitales, presupuesto, conflictos del sector, vacunas, salud mental, salud sexual, ANMAT, PAMI, obras sociales, medicamentos',
  },
  {
    emoji: '♀️',
    nombre: 'GÉNERO',
    descripcion: 'políticas de género, violencia de género, femicidios/travesticidios, leyes de género, derechos LGBTIQ+, aborto, cuidados, maternidad, brecha salarial, paridad',
  },
  {
    emoji: '🤝',
    nombre: 'BRIGADAS SOLIDARIAS',
    descripcion: 'situación de personas en situación de calle, condiciones materiales en barrios populares y villas, economía popular, trabajadoras y trabajadores de la economía popular (MTE, UTEP, cartoneros, vendedores ambulantes), organizaciones de base territorial, comedores comunitarios, merenderos, ollas populares, asistencia alimentaria, emergencia habitacional, frío e invierno en sectores vulnerables, IFE/AUH/programas sociales. NO incluir economía macro general, política partidaria sin vínculo territorial, seguridad/inseguridad genérica, ni declaraciones eclesiásticas amplias.',
  },
];

function buildWeeklyPromptForAreas(
  areas: AreaConfig[],
  articlesContext: string,
  dateLong: string,
  isFirstChunk: boolean,
  isLastChunk: boolean
): string {
  const intro = isFirstChunk
    ? `🗞️ *PATRIA GRANDE — Resumen Semanal*
📅 ${dateLong}

━━━━━━━━━━━━━━━━━
🔗 LA SEMANA EN PATRIA GRANDE
━━━━━━━━━━━━━━━━━
[Generá un panorama integrador de 3-4 oraciones que conecte temáticamente las 5 áreas de trabajo de la semana: cultura, educación, salud, género y brigadas solidarias. Tono militante peronista.]

`
    : '';

  const cierre = isLastChunk
    ? `

━━━━━━━━━━━━━━━━━
✌️🇦🇷 *Patria Grande* | Semanal — ${dateLong.split(' de ').slice(0, 2).join('/')}`
    : '';

  const areasInstrucciones = areas.map(area => `
━━━━━━━━━━━━━━━━━
${area.emoji} ${area.nombre}
━━━━━━━━━━━━━━━━━
🇦🇷 *Nacional:* [Una nota relevante de ARGENTINA EXCLUSIVAMENTE sobre ${area.descripcion}. NO incluir notas sobre otros países (Brasil, Uruguay, EEUU, etc) en este nivel — esas van a "internacional" en otros boletines, NO acá. 2 oraciones máximo: qué pasó + por qué importa.]
🔗 [link acortado] ([Medio])

🏛️ *Provincial:* [Una nota relevante de la PROVINCIA DE BUENOS AIRES sobre la misma área. NO incluir notas de otras provincias (Córdoba, Santa Fe, etc) ni de Nación. 2 oraciones.]
🔗 [link] ([Medio])

📍 *Municipal:* [Una nota relevante DEL MUNICIPIO DE QUILMES EXCLUSIVAMENTE sobre la misma área. NO incluir notas de otros distritos del sur GBA (Berazategui, Avellaneda, Florencio Varela, Lomas de Zamora, etc) — solo Quilmes. 2 oraciones.]
🔗 [link] ([Medio: InfoQuilmes / Inforegión / otro local sobre Quilmes])

[REGLAS DE COMBINACIÓN Y OMISIÓN:
- Si para esta área NO hay nota provincial O NO hay municipal en la semana, combiná las dos en una sola fila etiquetada como "🏛️📍 *Provincial/Municipal:*". 
- Si NO hay material en ninguno de los dos niveles (provincial ni municipal), omití ambas filas (mantené solo la fila Nacional).
- Si NO hay nota nacional sobre Argentina específicamente, omití también esa fila.
- Es preferible omitir un nivel a inventar contenido o usar contenido geográficamente incorrecto.
- VERIFICACIÓN: antes de incluir una nota, asegurate de que el contenido sea geográficamente correcto. Si una nota dice "Brasil avanza en clonación" NO entra como nacional. Si una nota dice "Berazategui inaugura..." NO entra como municipal.]
`).join('\n');

  return `${intro}${areasInstrucciones}${cierre}`;
}

function buildWeeklySystemPrompt(): string {
  return `Sos el editor del boletín semanal de Patria Grande Quilmes, una organización peronista y popular argentina.

Generás el *boletín semanal del sábado* que va al grupo de difusión. Reúne lo más importante de la semana organizado por las 5 áreas de trabajo concretas de la organización en Quilmes.

ÁREAS DE TRABAJO:
- 🎭 Cultura
- 📚 Educación
- 🏥 Salud
- ♀️ Género
- 🤝 Brigadas Solidarias (foco específico: personas en situación de calle, barrios populares y villas, economía popular, organizaciones territoriales de base como MTE/UTEP, comedores y merenderos, asistencia alimentaria, emergencia habitacional, programas sociales como IFE/AUH. NO entran temas de economía macro genérica, política partidaria sin vínculo territorial, ni inseguridad/seguridad si no toca a estos sectores.)

ESTRUCTURA POR ÁREA:
Cada área tiene 3 niveles geográficos ESTRICTAMENTE DEFINIDOS:
- 🇦🇷 *Nacional*: SOLO noticias de Argentina (no de otros países). Si la única información disponible es de otro país, omitir.
- 🏛️ *Provincial*: SOLO noticias de la Provincia de Buenos Aires (no Córdoba, Santa Fe, etc).
- 📍 *Municipal*: SOLO noticias del Municipio de Quilmes (no Berazategui, Florencio Varela, Lanús, ni otros distritos).

En cada nivel se elige UNA noticia relevante de la semana — puede ser coyuntural, anuncio de medida política, conflicto, discusión pública, o nota de análisis.

REGLAS DE CONTENIDO:
- Lenguaje militante peronista, claro y directo, accesible para simpatizantes.
- Perspectiva de género NATURAL: en el área de Género va de fondo; en otras áreas, solo cuando el tema lo amerita.
- Puntuación castellana correcta: ¡! y ¿? donde corresponda.
- Calidad alta: priorizar notas con respaldo, descartar rumores o títulos clickbait.
- Todos los links YA ESTÁN ACORTADOS (tinyurl): usalos textualmente, NO modifiques nada.
- Solo usar URLs de la lista de "URLs PERMITIDAS" del contexto del usuario.
- DESCRIPCIONES BREVES: 2 oraciones por nota máximo.

REGLA CRÍTICA DE CALIDAD DE LINKS:
Cada artículo del contexto tiene un TÍTULO específico. SOLO incluir notas cuyo título describa una noticia concreta. NO incluir nunca:
- Títulos genéricos tipo "agenda", "categoría", "sección", "novedades", "todas las noticias"
- Títulos que sean nombres de secciones del medio (ej: "Cultura - InfoQuilmes", "Educación", "Género")
- Títulos que sean solo el nombre del medio o subdominios
- URLs que terminen en /category/, /seccion/, /tag/, /agenda, /todos, etc.
Si para algún nivel solo hay material de ese tipo (linkos de sección sin nota concreta), preferí OMITIR ese nivel antes que incluir un link basura. La regla de combinación Provincial/Municipal aplica también si una de las dos solo tiene links de sección.

REGLA DE COMBINACIÓN PROVINCIAL/MUNICIPAL:
Si para alguna área no hay material provincial O no hay material municipal en la ventana semanal, combiná los dos niveles en uno solo: "🏛️📍 *Provincial/Municipal:*". Si no hay material en ninguno de los dos, omití ambas filas y dejá solo la fila Nacional.

Generá EXACTAMENTE las áreas que se te piden en el bloque de instrucciones del usuario. NO agregues áreas extras, NO omitas las pedidas.`;
}

async function handleWeeklyDigest(
  supabase: any,
  GEMINI_API_KEY: string,
  scheduleName: string
): Promise<Response> {
  const corsHdrs = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };

  // Ventana de 7 días
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: articles, error: artErr } = await supabase
    .from('scraped_articles')
    .select('*, media_sources(name, category, language)')
    .gte('scraped_at', since)
    .order('scraped_at', { ascending: false })
    .limit(800);

  if (artErr) throw artErr;
  if (!articles || articles.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: 'Sin artículos en los últimos 7 días' }),
      { headers: corsHdrs }
    );
  }

  // Filtrar artículos que parecen páginas de sección/agenda en lugar de notas concretas.
  // Sin esto, Gemini elige links basura cuando no encuentra nada mejor.
  const isLikelySectionPage = (a: any): boolean => {
    const url = (a.url || '').toLowerCase();
    const title = (a.title || '').toLowerCase().trim();
    // URLs sospechosas (paths de sección, categoría, tag, agenda)
    if (/\/(category|categoria|categorias|seccion|secciones|sección|tag|tags|agenda|todos|todas|archivo|archivos)\b/.test(url)) return true;
    // URL termina en "/" o el path es muy corto (probablemente home/sección)
    const pathSegments = url.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
    if (pathSegments.length <= 1) return true;
    // Títulos genéricos típicos de páginas de sección
    const genericTitles = [
      /^(cultura|educaci[oó]n|salud|g[eé]nero|pol[ií]tica|deportes|sociedad|econom[ií]a)\s*[-|–—]/i,
      /archivos?$/i,
      /^agenda\b/i,
      /\bsecci[oó]n\b/i,
      /\bcategor[ií]a\b/i,
    ];
    if (genericTitles.some(re => re.test(title))) return true;
    // Título muy corto (< 25 chars) suele ser sección, no nota
    if (title.length < 25) return true;
    return false;
  };

  const articlesFiltered = articles.filter((a: any) => !isLikelySectionPage(a));
  console.log(`[weekly] Artículos descartados por ser páginas de sección: ${articles.length - articlesFiltered.length}`);

  if (articlesFiltered.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: 'Tras filtrar, no quedaron artículos válidos' }),
      { headers: corsHdrs }
    );
  }

  // Acortar URLs en batch
  const allUrls = articlesFiltered.map((a: any) => a.url).filter(Boolean);
  const shortUrlMap = await shortenAll(allUrls);
  const withShort = articlesFiltered.map((a: any) => ({
    ...a,
    url_short: shortUrlMap.get(a.url) || a.url,
  }));

  // Formatear contexto compacto
  const articlesContext = '## ARTÍCULOS DE LA SEMANA\n' + withShort.slice(0, 400).map((a: any) => {
    const src = a.media_sources as any;
    return `- "${a.title}" | ${src?.name || '?'} | cat=${src?.category || '?'} | ${a.url_short}\n  ${(a.summary || '').substring(0, 200)}`;
  }).join('\n');

  const allowedUrlsBlock = `\n\n## URLs PERMITIDAS\n${
    withShort.map((a: any) => a.url_short).filter(Boolean).join('\n').substring(0, 12000)
  }`;

  // Fecha
  const nowAR = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const dateLong = `${dayNames[nowAR.getUTCDay()]} ${nowAR.getUTCDate()} de ${monthNames[nowAR.getUTCMonth()]} de ${nowAR.getUTCFullYear()}`;

  const systemPrompt = buildWeeklySystemPrompt();

  // Una sola llamada con las 5 áreas. Antes lo dividíamos en 2 chunks pero
  // generaba duplicación porque el system prompt describe la estructura completa.
  // Con maxOutputTokens=12000 entran las 5 áreas × 3 niveles cómodos.
  const userPrompt = `${buildWeeklyPromptForAreas(AREAS, articlesContext, dateLong, true, true)}

${articlesContext}${allowedUrlsBlock}`;

  console.log(`[${scheduleName}] Generando boletín semanal completo (${AREAS.length} áreas, una sola llamada)`);

  const r1 = await callGemini(GEMINI_API_KEY, systemPrompt, userPrompt, 12000);
  const fullMessage = r1.text.trim();

  console.log(`[${scheduleName}] Modelo usado: ${r1.modelUsed}`);
  console.log(`[${scheduleName}] Longitud final: ${fullMessage.length} chars`);

  // Notas de aprendizaje (cortas para no consumir tokens)
  let learningNotes = '';
  try {
    const learningPrompt = `Analizás brevemente este boletín semanal recién generado:\n${fullMessage.substring(0, 1500)}\n\nGenerá 3 notas de aprendizaje sobre qué se podría mejorar en próximos boletines semanales (formato lista, 200 palabras máximo).`;
    const { text } = await callGemini(GEMINI_API_KEY, 'Sos un editor crítico. Castellano rioplatense.', learningPrompt, 800);
    learningNotes = text;
  } catch {
    learningNotes = 'Sin notas de aprendizaje en este ciclo.';
  }

  // Guardar en DB (es boletín grupal)
  const { data: digest, error: digestErr } = await supabase
    .from('digest_sends')
    .insert({
      telegram_message: fullMessage,
      articles_count: articles.length,
      status: 'pending',
      digest_type: 'weekly',
      learning_notes: learningNotes,
    })
    .select()
    .single();

  if (digestErr) throw digestErr;

  return new Response(
    JSON.stringify({
      success: true,
      digest_id: digest.id,
      digest_type: 'weekly',
      articles_count: articles.length,
      message_length: fullMessage.length,
      models_used: [r1.modelUsed],
    }),
    { headers: corsHdrs }
  );
}
