import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  PERIODISTAS,
  detectJournalist,
  orientationScore,
  type Periodista,
} from '../_shared/journalists.ts';

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
        const rawText = await res.text();
        // Defensive: a veces Gemini (o un proxy upstream) devuelve HTML con status 200
        // cuando hay problemas. Si vemos HTML, lo tratamos como error transitorio.
        if (rawText.trim().startsWith('<')) {
          lastError = `${model} [200 pero HTML]: ${rawText.substring(0, 200)}`;
          console.warn(`${model} devolvió HTML en lugar de JSON, tratando como error transitorio`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, retryDelays[attempt]));
            continue;
          }
          break;
        }
        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch (parseErr) {
          lastError = `${model} [JSON parse error]: ${rawText.substring(0, 200)}`;
          console.error(`${model} respuesta no es JSON válido: ${rawText.substring(0, 200)}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, retryDelays[attempt]));
            continue;
          }
          break;
        }
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

REGLA ANTI-DUPLICACIÓN (CRÍTICO):
Cada URL/link aparece UNA SOLA VEZ en todo el mensaje. Una nota que ya usaste en "ARGENTINA" NO puede volver a aparecer en "INTERNACIONAL", "FUERA DE AGENDA" ni en "ANÁLISIS". Cuando estés por incluir una nota en una sección, verificá mentalmente que su URL no esté en ninguna sección anterior. Si una nota podría ir en dos secciones, elegí la sección donde tenga MÁS encaje y omitila de la otra.

REGLA DE FIDELIDAD AL CONTENIDO (CRÍTICO):
NO inventes detalles que no estén en el título o resumen del artículo. Si un artículo dice "Violencia en escuelas — Diagonales" sobre algún hecho específico, NO inventes que ocurrió en Quilmes si el cuerpo no lo dice. Si la nota es de otro país (ej: contagio de VIH en Pakistán), NO la presentes como si fuera de Argentina. Tu descripción debe basarse SOLO en lo que el título y resumen del artículo dicen literalmente.

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

REGLA ANTI-DUPLICACIÓN (CRÍTICO):
Cada URL/link aparece UNA SOLA VEZ en todo el boletín. Una nota usada en "ARGENTINA" NO puede aparecer también en "EL MUNDO", "QUILMES", "FUERA DE AGENDA" ni en "PARA PROFUNDIZAR". Si una nota podría ir en dos secciones, elegí la que mejor le corresponda y omitila de la otra.

REGLA DE FIDELIDAD AL CONTENIDO (CRÍTICO):
NO inventes detalles que no estén en el título o resumen del artículo. NO ubiques noticias en lugares donde no ocurrieron. Si el artículo es sobre Pakistán, NO lo cuentes como si fuera de Argentina. Si el artículo no aclara la zona específica, NO inventes que es de Quilmes.

REGLA DE QUILMES ESTRICTO (📍):
La sección 📍 QUILMES SOLO acepta notas cuyo CONTENIDO real (no solo el título) refiere a hechos ocurridos en el partido de Quilmes (ciudad de Quilmes, Bernal, Don Bosco, Ezpeleta, San Francisco Solano, Villa La Florida, Villa Itatí, La Matera, La Cañada). NO acepta notas de Lanús, Avellaneda, Lomas de Zamora, Almirante Brown, Berazategui, Florencio Varela, Esteban Echeverría, Ezeiza, La Plata, Berisso, Ensenada, ni de zonas genéricas como "sur del conurbano" o "zona sur". Si la única nota local disponible es de un distrito vecino, OMITÍ la sección 📍 QUILMES por completo. NUNCA renombres una nota de otro distrito como si fuera de Quilmes.

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
    // digest_type: 'personal' | 'group' | 'weekly' | 'monday_realidad'
    const digestType: 'personal' | 'group' | 'weekly' | 'monday_realidad' = body.digest_type || 'group';
    const scheduleName: string = body.schedule_name || 'Manual';

    // ── Rama: boletín semanal (martes 20:00 — antes sábados) ──────────────────
    // Lógica completamente separada del flujo diario.
    if (digestType === 'weekly') {
      return await handleWeeklyDigest(supabase, GEMINI_API_KEY, scheduleName);
    }

    // ── Rama: boletín lunes "La única verdad es la realidad" ──────────────────
    // Temas centrales de la última semana, AR + PBA + Quilmes, con clustering
    // y multi-link por nota. Lógica separada del flujo diario.
    if (digestType === 'monday_realidad') {
      return await handleMondayRealidad(supabase, GEMINI_API_KEY, scheduleName);
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

    // ── Validación post-Gemini: detectar URLs duplicadas entre secciones ──────
    // Cada URL debe aparecer una sola vez en todo el mensaje. Si aparece más,
    // dejamos un aviso al final para que se revise antes de reenviar.
    let cleanMessage = digestMessage;
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const foundUrls = (digestMessage.match(urlPattern) || []).map(u => u.replace(/[.,;:!?)]+$/, ''));
    const urlCounts = new Map<string, number>();
    for (const u of foundUrls) urlCounts.set(u, (urlCounts.get(u) || 0) + 1);
    const duplicateUrls = [...urlCounts.entries()].filter(([_, c]) => c > 1).map(([u]) => u);

    if (duplicateUrls.length > 0) {
      console.warn(`[${scheduleName}] URLs duplicadas detectadas (${duplicateUrls.length}):`, duplicateUrls.slice(0, 5));
      cleanMessage = digestMessage.trimEnd()
        + `\n\n⚠️ *Aviso de calidad*: ${duplicateUrls.length} link(s) duplicado(s) entre secciones — revisar antes de reenviar.`;
    }
    // ─────────────────────────────────────────────────────────────────────────

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
          telegram_message: cleanMessage,
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
          message_length: cleanMessage.length,
          duplicates_detected: duplicateUrls.length,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Resumen personal: solo devolver el mensaje, no guardar en DB ──────────
    return new Response(
      JSON.stringify({
        success: true,
        digest_type: 'personal',
        message: cleanMessage,
        articles_count: articlesToUse.length,
        noticias_count: noticias.length,
        analisis_count: analisis.length,
        novel_analysis_count: novelAnalisisShort.length,
        message_length: cleanMessage.length,
        duplicates_detected: duplicateUrls.length,
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
  // Keywords que cuentan como pertenecientes a esta área. Lowercase, sin tildes para
  // que el match sea más laxo. Una sola coincidencia en título o resumen alcanza.
  keywords: string[];
  // Keywords que descalifican un artículo aunque tenga match positivo (override)
  excludeKeywords?: string[];
}

const AREAS: AreaConfig[] = [
  {
    emoji: '🎭',
    nombre: 'CULTURA',
    descripcion: 'política cultural, financiamiento, instituciones, festivales, espacios culturales, industrias culturales, libros, cine, música, teatro, patrimonio',
    keywords: [
      'cultura', 'cultural', 'cine', 'pelicula', 'película', 'cineasta', 'director',
      'libro', 'autora', 'autor', 'literatura', 'editorial', 'feria del libro',
      'musica', 'música', 'concierto', 'recital', 'banda', 'cantante', 'álbum',
      'teatro', 'obra', 'actor', 'actriz', 'estreno', 'guion',
      'museo', 'patrimonio', 'arte', 'artista', 'pintor', 'exposición', 'muestra',
      'centro cultural', 'biblioteca', 'incaa', 'mecenazgo', 'cultura pública',
      'festival', 'audiovisual', 'streaming', 'documental',
    ],
  },
  {
    emoji: '📚',
    nombre: 'EDUCACIÓN',
    descripcion: 'educación pública, presupuesto, paritarias docentes, universidades, escuelas, infancias, conflictos gremiales del sector, leyes educativas',
    keywords: [
      'educación', 'educacion', 'educativ', 'docente', 'maestra', 'maestro', 'profesor',
      'escuela', 'colegio', 'aula', 'jardín', 'jardin', 'inicial', 'primaria', 'secundaria',
      'universidad', 'universitar', 'estudiante', 'alumno', 'alumna',
      'paritaria docente', 'gremio docente', 'sutech', 'suteba', 'ctera', 'udocba',
      'becas progresar', 'progresar', 'beca', 'fonid',
      'incentivo docente', 'capital humano', 'ministerio de educación', 'pelta',
      'sae', 'comedor escolar', 'libros escolares', 'útiles', 'cuadernos',
      'evaluación aprender', 'censo educativo', 'analfabetismo',
    ],
  },
  {
    emoji: '🏥',
    nombre: 'SALUD',
    descripcion: 'salud pública, hospitales, presupuesto, conflictos del sector, vacunas, salud mental, salud sexual, ANMAT, PAMI, obras sociales, medicamentos',
    keywords: [
      // Salud pública / sistema sanitario (frases completas)
      'salud publica', 'salud pública', 'sistema de salud', 'sistema sanitario',
      'ministerio de salud', 'secretaria de salud', 'secretaría de salud',
      'politica sanitaria', 'política sanitaria', 'politica de salud', 'política de salud',
      'presupuesto en salud', 'presupuesto sanitario',
      'efectores de salud', 'centros de salud', 'centro de salud',
      // Hospitales e instituciones
      'hospital ', 'hospitales', 'hospitalari', 'clínica médica', 'clinica medica',
      'caps ', 'sala de salud', 'salas de salud',
      'guardia médica', 'guardia medica', 'guardia hospitalaria',
      'unidad sanitaria', 'unidades sanitarias',
      // Trabajadores del sector
      'profesionales de la salud', 'trabajadores de la salud',
      'personal de salud', 'personal sanitario', 'agentes sanitarios',
      'colegio de médicos', 'colegio medico',
      'caja de jubilaciones médicas', 'caja medica',
      // Medicamentos y reguladores
      'medicamento', 'medicamentos', 'remedios', 'farmacia',
      'anmat', 'fda', 'vacuna', 'vacunación', 'vacunacion', 
      'inmunización', 'inmunizacion', 'campaña de vacunación', 'campaña de vacunacion',
      // Coberturas
      'pami', 'obras sociales', 'obra social', 'prepaga', 'prepagas',
      'iosfa', 'ioma', 'osecac', 'osde', 'swiss medical', 'galeno', 'medife',
      // Profesionales y trabajadores
      'paciente', 'pacientes', 'médico', 'medica', 'médica', 'doctor', 'doctora',
      'enfermería', 'enfermeria', 'enfermera', 'enfermero', 
      'kinesiología', 'kinesiologia',
      'residencias médicas', 'residencias medicas',
      // Salud mental / sexual
      'salud mental', 'suicidio', 'depresión clínica', 'depresion clinica',
      'el borda', 'hospital borda',
      'salud sexual', 'derechos sexuales y reproductivos',
      'aborto legal', 'ile ', 'ive ', 
      'interrupción voluntaria del embarazo', 'interrupcion voluntaria del embarazo',
      // Enfermedades / epidemias
      'sarampión', 'sarampion', 'dengue', 'covid', 'sars-cov',
      'gripe a', 'gripe estacional',
      'epidem', 'pandem', 'brote epidemiologico', 'brote epidemiológico',
      'foco infeccioso',
      // Conflictos del sector
      'paritaria de salud', 'paro de salud', 'conflicto sanitario',
      'recorte en salud', 'desfinanciamiento salud', 'desfinanciamiento sanitario',
    ],
    excludeKeywords: [
      // Evitar matchear "salud y bienestar" en contextos económicos/de consumo
      'salud financiera', 'salud económica', 'salud economica',
      'salud del consumidor', 'salud crediticia',
    ],
  },
  {
    emoji: '♀️',
    nombre: 'GÉNERO',
    descripcion: 'políticas de género, violencia de género, femicidios/travesticidios, leyes de género, derechos LGBTIQ+, aborto, cuidados, maternidad, brecha salarial, paridad',
    keywords: [
      // Violencia y crímenes específicos del campo
      'violencia de género', 'violencia machista', 'violencia patriarcal',
      'femicidio', 'femicidios', 'travesticidio', 'travesticidios',
      'transfemicidio', 'lesbicidio',
      'desaparecida', 'búsqueda activa', 'alerta sofia', 'alerta sofía',
      'abuso sexual', 'violación', 'violacion',
      // Movimiento y política
      'feminismo', 'feminista', 'feministas', 'movimiento de mujeres',
      'movimiento feminista',
      'ni una menos', 'paro de mujeres', '8m', '3j',
      // LGBTIQ+
      'lgbt', 'lgbtiq', 'lgbtq', 'comunidad lgbt',
      'identidad de género', 'identidad de genero', 'cupo trans',
      'cupo laboral travesti', 'cupo laboral trans',
      'matrimonio igualitario', 'ley de identidad de género',
      'colectivo travesti', 'colectivo trans',
      'orgullo lgbt', 'marcha del orgullo',
      // Derechos sexuales y reproductivos
      'aborto legal', 'ile ', 'ive ',
      'interrupción voluntaria del embarazo', 'interrupcion voluntaria del embarazo',
      'derechos sexuales y reproductivos',
      'salud sexual y reproductiva', 'objeción de conciencia',
      // Cuidados / brecha
      'tareas de cuidado', 'economía del cuidado', 'economia del cuidado',
      'brecha salarial', 'brecha de género', 'brecha de genero',
      'paridad de género', 'paridad de genero', 'ley de paridad',
      'salario para amas de casa', 'reconocimiento de cuidados',
      // ESI
      'educación sexual integral', 'educacion sexual integral', 'esi ',
      // Política específica de género
      'ministerio de mujeres', 'ministerio de las mujeres',
      'secretaria de la mujer', 'secretaría de la mujer',
      'política de género', 'políticas de género', 'politica de genero',
      // Específicos
      'travesti', 'trans ', 'no binarie', 'no binaria', 'no binario',
      'lesbiana', 'lesbianas', 'gay', 'gays', 'bisexual', 'bisexuales',
    ],
    excludeKeywords: [
      // Evitar usos genéricos del término "mujer" en contextos económicos / políticos
      // que ya tendrían su propia área. Ej: "mujeres y diversidades golpeadas por la inflación"
      // entra como Brigadas o como tema económico, no como Género.
      'inflación mensual', 'inflacion mensual', 'tipo de cambio',
      'reservas bcra', 'dólar blue', 'dolar blue',
    ],
  },
  {
    emoji: '🤝',
    nombre: 'BRIGADAS SOLIDARIAS',
    descripcion: 'personas en situación de calle, barrios populares y villas, economía popular, organizaciones territoriales, comedores y merenderos',
    keywords: [
      // Situación de calle
      'situación de calle', 'situacion de calle', 'sin techo', 'personas sin techo',
      'paradores', 'parador municipal', 'parador nocturno',
      // Barrios populares
      'barrio popular', 'barrios populares', 'villas y asentamientos',
      'asentamiento informal', 'asentamientos populares', 'tomas de tierra',
      'reurbanización', 'reurbanizacion', 'renabap',
      'integración urbana', 'integracion urbana',
      // Economía popular
      'economía popular', 'economia popular', 'salario social complementario',
      'mte ', 'utep ', 'cooperativa de trabajo', 'cooperativismo',
      'cartonero', 'cartoneros', 'recuperadores urbanos',
      'vendedor ambulante', 'vendedores ambulantes', 'manteros',
      'feriante', 'feriantes', 'feria popular',
      'changarines', 'changas',
      // Comedores
      'comedor comunitario', 'comedores comunitarios', 'comedor escolar',
      'merendero', 'merenderos', 'olla popular', 'ollas populares',
      'copa de leche',
      // Asistencia
      'asistencia alimentaria', 'tarjeta alimentar', 'plan alimentar',
      'caja de alimentos', 'cajas de alimentos', 'modulo alimentario',
      'módulo alimentario', 'bolsón alimentario', 'bolson alimentario',
      'mesa-mas vida', 'mas vida', 'plan más vida', 'plan mas vida',
      'vianda escolar', 'sae escolar',
      // Habitacional / frío
      'emergencia habitacional', 'desalojo violento', 'desalojos',
      'operativo frio', 'operativo frío', 'campaña de invierno',
      // Programas sociales
      'asignación universal por hijo', 'asignacion universal por hijo',
      'plan social', 'planes sociales', 'potenciar trabajo', 'progresar',
      'pension no contributiva', 'pensión no contributiva',
      // Movimientos / organizaciones territoriales
      'movimiento popular', 'movimientos sociales',
      'organización territorial', 'organizacion territorial',
      'organizaciones sociales', 'organizaciones territoriales',
      'frente patria grande', 'frente de organizaciones',
      'barrios de pie', 'somos barrios de pie',
      'movimiento evita', 'corriente clasista combativa',
      'ctep ', 'la dignidad', 'movimiento popular la dignidad',
      'grabois',
      // Pobreza
      'pobreza estructural', 'pobreza por ingresos', 'indec pobreza',
      'hambre', 'desnutrición', 'desnutricion',
      'inseguridad alimentaria',
    ],
    excludeKeywords: [
      // Evitar economía macro genérica
      'tipo de cambio', 'dólar blue', 'dolar blue', 'reservas bcra',
      'inflación mensual', 'inflacion mensual', 'imae', 'pbi ',
      // Evitar declaraciones eclesiásticas amplias
      'conferencia episcopal', 'episcopal argentina', 'cardenal', 'obispo',
      // Evitar política partidaria sin vínculo territorial
      'interna pj', 'interna del pj',
      // Evitar bienestar animal y limpieza/medio ambiente que no son del área
      'bienestar animal', 'maltrato animal', 'caballos',
      'arrojaban basura', 'arrojan basura', 'basura clandestina',
    ],
  },
];

// Quita tildes para hacer el match laxo
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function articleMatchesArea(article: any, area: AreaConfig): boolean {
  const haystack = normalize(`${article.title} ${article.summary || ''}`);
  const inc = area.keywords.some(kw => haystack.includes(normalize(kw)));
  if (!inc) return false;
  if (area.excludeKeywords && area.excludeKeywords.length > 0) {
    const excl = area.excludeKeywords.some(kw => haystack.includes(normalize(kw)));
    if (excl) return false;
  }
  return true;
}

// Niveles geográficos
type GeoLevel = 'national' | 'provincial' | 'municipal';

// Listas de medios por nivel geográfico
const NATIONAL_MEDIA = [
  'clarin', 'la nacion', 'infobae', 'ambito', 'pagina|12', 'pagina/12', 'pagina 12',
  'el destape', 'el cohete a la luna', 'tiempo argentino', 'cenital', 'panama revista',
  'el grito del sur', 'el diario ar', 'cgtn', 'reuters', 'bbc mundo',
  'revista anfibia', 'revista crisis', 'letra p', 'diagonales', 'perspectiva sur',
  'le monde diplomatique', 'econojournal', 'va con firma', 'kranear', 'cepa', 'mate',
];

const QUILMES_MARKERS = [
  // Centros y zonas principales del partido de Quilmes
  'quilmes', 'quilmes oeste', 'quilmes centro', 'quilmes este',
  'don bosco', 'bernal', 'bernal oeste', 'bernal este',
  'ezpeleta', 'ezpeleta oeste', 'ezpeleta este',
  'san francisco solano', 'solano',
  // Barrios de Quilmes
  'villa la florida', 'villa itati', 'villa itatí',
  'villa lujan', 'villa luján',
  'la matera', 'la cañada', 'la canada', 'la ribera',
  'iapi', 'el monte', 'monte chingolo quilmes',
  // Marcas e instituciones quilmeñas
  'isidoro iriarte', 'hospital iriarte', 'hospital de quilmes',
  'mayra mendoza', 'cervecería quilmes', 'cerveceria quilmes',
  'club atletico quilmes', 'club atlético quilmes',
];

// Otros distritos del sur GBA que NO son Quilmes (para excluir)
const NOT_QUILMES_DISTRICTS = [
  'avellaneda', 'lanus', 'lanús', 'lomas de zamora', 'almirante brown', 'berazategui',
  'florencio varela', 'esteban echeverria', 'ezeiza', 'la plata', 'berisso', 'ensenada',
];

function detectGeoLevel(article: any): GeoLevel | 'unknown' {
  const title = normalize(article.title || '');
  const summary = normalize(article.summary || '');
  const haystack = `${title} ${summary}`;
  const sourceName = normalize(article.media_sources?.name || '');

  // Contar menciones de Quilmes y de otros distritos para calidad de match
  const countMatches = (text: string, terms: string[]): number =>
    terms.reduce((acc, t) => acc + (text.split(normalize(t)).length - 1), 0);

  const quilmesHitsTitle = countMatches(title, QUILMES_MARKERS);
  const quilmesHitsTotal = countMatches(haystack, QUILMES_MARKERS);
  const otherDistrictHits = countMatches(haystack, NOT_QUILMES_DISTRICTS);

  // 1. Municipal STRICT: Quilmes está en el TÍTULO y NO hay menciones de otros distritos.
  // Esto evita que una nota "Violencia escolar en Lanús; en Quilmes también pasa"
  // se cuele como municipal de Quilmes.
  if (quilmesHitsTitle >= 1 && otherDistrictHits === 0) return 'municipal';

  // 2. Municipal por fuente: InfoQuilmes Y mención de Quilmes en cualquier parte
  // Y sin mencionar otros distritos (porque InfoQuilmes a veces cubre la región).
  if (sourceName.includes('infoquilmes') && quilmesHitsTotal >= 1 && otherDistrictHits === 0) {
    return 'municipal';
  }

  // 3. Provincial: menciones de la provincia/Kicillof/La Plata, sin Quilmes
  if (
    /provincia de buenos aires|kicillof|la plata|conurbano bonaerense|provincia bonaerense|gobierno bonaerense|legislatura bonaerense|gobernacion bonaerense|gobernación bonaerense/.test(haystack)
    && quilmesHitsTotal === 0
  ) return 'provincial';

  // 4. Si la fuente local (Inforegión / InfoQuilmes) menciona OTROS distritos sin Quilmes,
  // marcamos provincial (regional pero NO Quilmes).
  if (
    (sourceName.includes('inforegion') || sourceName.includes('infoquilmes'))
    && otherDistrictHits >= 1
    && quilmesHitsTitle === 0
  ) return 'provincial';

  // 5. Nacional: medios nacionales SIN mención específica regional, contenido sobre Argentina.
  // Importante: NO devolver 'national' por default — si la nota es claramente sobre otro país,
  // tiene que terminar como 'unknown'. Buscamos señales positivas de Argentina.
  const isNationalMedia = NATIONAL_MEDIA.some(m => sourceName.includes(m));
  const mentionsArgentina = /\bargentina\b|\bargentino\b|\bargentina\b|gobierno nacional|congreso de la nacion|senado de la nacion|camara de diputados|presidencia de la nacion|milei|cristina kirchner/.test(haystack);
  // Señales de que la nota es de OTRO país (no entra como nacional argentino)
  const looksForeign = /pakistan|paquistan|india|china|brasil|uruguay|chile|peru|venezuela|colombia|mexico|estados unidos|eeuu|francia|alemania|italia|espana|reino unido|trump|biden|lula|petro|maduro|boric|bolsonaro/.test(haystack);

  if (isNationalMedia && mentionsArgentina && !looksForeign) return 'national';
  if (mentionsArgentina && !looksForeign) return 'national';

  return 'unknown';
}

interface CandidateArticle {
  title: string;
  summary: string;
  url_short: string;
  source: string;
  scraped_at: string;
}

function pickCandidates(
  articles: any[],
  area: AreaConfig,
  level: GeoLevel,
  max: number
): CandidateArticle[] {
  const matches = articles.filter((a: any) => {
    return articleMatchesArea(a, area) && detectGeoLevel(a) === level;
  });

  // Ordenar por más reciente primero, luego dedup por título normalizado para evitar
  // que el mismo evento aparezca 5 veces desde 5 medios distintos
  const seen = new Set<string>();
  const dedup: any[] = [];
  for (const a of matches) {
    const key = normalize(a.title || '').substring(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(a);
    if (dedup.length >= max) break;
  }

  return dedup.map((a: any) => ({
    title: a.title || '',
    summary: (a.summary || '').substring(0, 250),
    url_short: a.url_short || '',
    source: a.media_sources?.name || '?',
    scraped_at: a.scraped_at,
  }));
}

function buildWeeklyUserPrompt(
  candidatesByAreaLevel: Record<string, CandidateArticle[]>,
  dateLong: string,
  dateShort: string
): string {
  let prompt = `Generá el boletín semanal con las 5 áreas de trabajo de Patria Grande Quilmes.

REGLAS ABSOLUTAS:
1. Para cada celda área × nivel, elegí UNA nota de los CANDIDATOS que te paso abajo. NO inventes notas que no estén en la lista.
2. Tu descripción debe ser FIEL al título y resumen del candidato elegido. NO inventes detalles, instituciones, programas o fechas que no estén explícitos.
3. Usá el url_short EXACTO del candidato elegido. NO modifiques el link.
4. Si una celda tiene 0 candidatos, OMITÍ esa fila (regla de combinación abajo).
5. Si una celda tiene candidatos pero ninguno es realmente sobre el área, OMITÍ esa fila igualmente.
6. Si Provincial está vacío O Municipal está vacío, combiná ambos en "🏛️📍 *Provincial/Municipal:*" usando el que sí tenga material.
7. Si AMBOS (Provincial y Municipal) están vacíos, dejá solo la fila Nacional para esa área.

ESTRUCTURA EXACTA del boletín que tenés que generar:

🗞️ *PATRIA GRANDE — Resumen Semanal*
📅 ${dateLong}

━━━━━━━━━━━━━━━━━
🔗 LA SEMANA EN PATRIA GRANDE
━━━━━━━━━━━━━━━━━
[2-3 oraciones cortas y concretas: qué fue lo más relevante de la semana mirando el conjunto. Lenguaje militante pero no exagerado. NO inventes acciones ni hechos. NO digas que "Patria Grande hizo X" si no aparece en los candidatos.]

`;

  for (const area of AREAS) {
    prompt += `━━━━━━━━━━━━━━━━━\n${area.emoji} *${area.nombre}*\n━━━━━━━━━━━━━━━━━\n`;

    const candNat = candidatesByAreaLevel[`${area.nombre}__national`] || [];
    const candProv = candidatesByAreaLevel[`${area.nombre}__provincial`] || [];
    const candMun = candidatesByAreaLevel[`${area.nombre}__municipal`] || [];

    prompt += `\n[Candidatos disponibles para ${area.nombre}]\n`;
    prompt += `\nNacional (${candNat.length}):\n`;
    if (candNat.length === 0) prompt += '  (vacío — omití la fila Nacional)\n';
    else candNat.forEach((c, i) => {
      prompt += `  ${i + 1}. "${c.title}" | ${c.source} | ${c.url_short}\n     ${c.summary}\n`;
    });

    prompt += `\nProvincial (${candProv.length}):\n`;
    if (candProv.length === 0) prompt += '  (vacío)\n';
    else candProv.forEach((c, i) => {
      prompt += `  ${i + 1}. "${c.title}" | ${c.source} | ${c.url_short}\n     ${c.summary}\n`;
    });

    prompt += `\nMunicipal Quilmes (${candMun.length}):\n`;
    if (candMun.length === 0) prompt += '  (vacío)\n';
    else candMun.forEach((c, i) => {
      prompt += `  ${i + 1}. "${c.title}" | ${c.source} | ${c.url_short}\n     ${c.summary}\n`;
    });

    prompt += `\nGenerá ahora la sección ${area.emoji} *${area.nombre}* siguiendo las reglas. Si no hay candidatos para algún nivel, omití esa fila.\n\n`;
  }

  prompt += `\n━━━━━━━━━━━━━━━━━\n✌️🇦🇷 *Patria Grande* | Semanal — ${dateShort}\n\nGenerá ahora el boletín completo.`;

  return prompt;
}

function buildWeeklySystemPrompt(): string {
  return `Sos el editor del boletín semanal de Patria Grande Quilmes, una organización peronista y popular argentina.

Tu tarea ESTRICTA: a partir de los CANDIDATOS pre-seleccionados que te pasa el usuario, armás un boletín fiel a esos candidatos. NO inventás noticias. NO inventás detalles que no estén explícitos en el título o resumen del candidato.

REGLAS ABSOLUTAS:
1. Solo usar notas que aparezcan en la lista de candidatos del usuario.
2. La descripción que escribís debe basarse EXCLUSIVAMENTE en el título y resumen del candidato. Si el candidato dice "El gobierno anunció X", escribí sobre X — no inventes detalles, programas o instituciones que no estén ahí.
3. Usar el url_short EXACTO del candidato. NO modificar.
4. 2 oraciones máximo por nota.
5. Lenguaje militante peronista pero NO sobreexagerado: que se note el posicionamiento sin caer en consigna vacía. Tono concreto, claro, sobrio.
6. Perspectiva de género NATURAL: en el área de Género va de fondo; en otras áreas, solo si el tema lo amerita realmente.
7. Puntuación castellana correcta: ¡! y ¿? donde corresponda.
8. Si una celda tiene 0 candidatos válidos, OMITÍ esa fila completa.
9. NUNCA inventes que "Patria Grande hizo X" o "las brigadas de Patria Grande Quilmes hicieron Y" si eso no aparece literalmente en los candidatos.
10. ANTI-DUPLICACIÓN: cada URL aparece UNA SOLA VEZ en todo el boletín. Si una nota ya la usaste en (área A, nivel X), NO la vuelvas a usar en otra celda. Si querés usarla, elegí la celda más apropiada y omitila de la otra. Recorré las celdas en orden y llevá una memoria mental de qué URLs ya usaste.
11. FIDELIDAD GEOGRÁFICA: una nota va a la fila "Municipal" SOLO si el contenido refiere a hechos en Quilmes (no solo si menciona "Quilmes" en pasada). Si una nota es de Pakistán, no la uses como nacional argentino. Si una nota es de "violencia escolar en Lanús", no la uses en municipal de Quilmes aunque el medio sea de la zona.

REGLA DE COMBINACIÓN PROVINCIAL/MUNICIPAL:
Si Provincial está vacío Y Municipal NO: usá la fila "🏛️📍 *Provincial/Municipal:*" con el material municipal.
Si Municipal está vacío Y Provincial NO: usá la fila "🏛️📍 *Provincial/Municipal:*" con el material provincial.
Si ambos están vacíos: omití ambas filas.

REGLA DE PANORAMA INICIAL:
El "PANORAMA DE LA SEMANA" debe ser CORTO (2-3 oraciones), CONCRETO y NO EXAGERADO. NO inventar acciones de Patria Grande. Solo conectar los temas de los candidatos elegidos.`;
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

  try {
    return await runWeeklyDigest(supabase, GEMINI_API_KEY, scheduleName, corsHdrs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error('[weekly] Crash:', msg);
    if (stack) console.error('[weekly] Stack:', stack);
    return new Response(
      JSON.stringify({
        success: false,
        error: msg,
        step: 'weekly_handler',
        stack: stack ? stack.substring(0, 500) : undefined,
      }),
      { status: 500, headers: corsHdrs }
    );
  }
}

async function runWeeklyDigest(
  supabase: any,
  GEMINI_API_KEY: string,
  scheduleName: string,
  corsHdrs: Record<string, string>
): Promise<Response> {
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

  // Filtro de páginas de sección/agenda
  const isLikelySectionPage = (a: any): boolean => {
    const url = (a.url || '').toLowerCase();
    const title = (a.title || '').toLowerCase().trim();
    if (/\/(category|categoria|categorias|seccion|secciones|sección|tag|tags|agenda|todos|todas|archivo|archivos)\b/.test(url)) return true;
    const pathSegments = url.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
    if (pathSegments.length <= 1) return true;
    const genericTitles = [
      /^(cultura|educaci[oó]n|salud|g[eé]nero|pol[ií]tica|deportes|sociedad|econom[ií]a)\s*[-|–—]/i,
      /archivos?$/i,
      /^agenda\b/i,
      /\bsecci[oó]n\b/i,
      /\bcategor[ií]a\b/i,
      /^novedades$/i,
    ];
    if (genericTitles.some(re => re.test(title))) return true;
    if (title.length < 25) return true;
    return false;
  };

  const articlesFiltered = articles.filter((a: any) => !isLikelySectionPage(a));
  console.log(`[weekly] Artículos filtrados (sección): ${articles.length - articlesFiltered.length}, restantes: ${articlesFiltered.length}`);

  if (articlesFiltered.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: 'Tras filtrar, no quedaron artículos válidos' }),
      { headers: corsHdrs }
    );
  }

  // Acortar URLs (solo de los que pasan el filtro inicial)
  const allUrls = articlesFiltered.map((a: any) => a.url).filter(Boolean);
  const shortUrlMap = await shortenAll(allUrls);
  const withShort = articlesFiltered.map((a: any) => ({
    ...a,
    url_short: shortUrlMap.get(a.url) || a.url,
  }));

  // ── Pre-clasificar candidatos por área × nivel ──────────────────────────────
  const candidatesByAreaLevel: Record<string, CandidateArticle[]> = {};
  const candidateStats: Record<string, number> = {};

  for (const area of AREAS) {
    for (const level of ['national', 'provincial', 'municipal'] as GeoLevel[]) {
      const cands = pickCandidates(withShort, area, level, 8); // 8 candidatos brutos por celda
      const key = `${area.nombre}__${level}`;
      candidatesByAreaLevel[key] = cands;
    }
  }

  // ── Dedup global entre celdas ───────────────────────────────────────────────
  // Si una URL aparece como candidato en múltiples celdas, la dejamos SOLO en la
  // primera celda que la contenga (orden definido por AREAS × niveles).
  // Esto evita que Gemini meta la misma nota en dos secciones distintas.
  // Después del dedup, recortamos cada celda a 5 candidatos.
  const seenUrls = new Set<string>();
  for (const area of AREAS) {
    for (const level of ['national', 'provincial', 'municipal'] as GeoLevel[]) {
      const key = `${area.nombre}__${level}`;
      const original = candidatesByAreaLevel[key] || [];
      const filtered: CandidateArticle[] = [];
      for (const cand of original) {
        if (cand.url_short && seenUrls.has(cand.url_short)) continue; // ya usada en otra celda
        if (cand.url_short) seenUrls.add(cand.url_short);
        filtered.push(cand);
        if (filtered.length >= 5) break; // máximo 5 por celda después del dedup
      }
      candidatesByAreaLevel[key] = filtered;
      candidateStats[key] = filtered.length;
    }
  }

  console.log(`[weekly] Candidatos pre-seleccionados (post-dedup):`, candidateStats);

  // Verificar que al menos haya algo para generar
  const totalCandidates = Object.values(candidateStats).reduce((a, b) => a + b, 0);
  if (totalCandidates === 0) {
    return new Response(
      JSON.stringify({
        success: true,
        message: 'No hay candidatos en ninguna área/nivel. Revisar keywords o ampliar fuentes.',
      }),
      { headers: corsHdrs }
    );
  }

  // Fecha
  const nowAR = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const dateLong = `${dayNames[nowAR.getUTCDay()]} ${nowAR.getUTCDate()} de ${monthNames[nowAR.getUTCMonth()]} de ${nowAR.getUTCFullYear()}`;
  const dateShort = `${String(nowAR.getUTCDate()).padStart(2, '0')}/${String(nowAR.getUTCMonth() + 1).padStart(2, '0')}`;

  const systemPrompt = buildWeeklySystemPrompt();
  const userPrompt = buildWeeklyUserPrompt(candidatesByAreaLevel, dateLong, dateShort);

  console.log(`[${scheduleName}] Generando boletín semanal con ${totalCandidates} candidatos pre-seleccionados`);

  const r1 = await callGemini(GEMINI_API_KEY, systemPrompt, userPrompt, 12000);
  let fullMessage = r1.text.trim();

  console.log(`[${scheduleName}] Modelo usado: ${r1.modelUsed}`);
  console.log(`[${scheduleName}] Longitud final: ${fullMessage.length} chars`);

  // ── Validación post-Gemini ──────────────────────────────────────────────────
  // 1) URLs que aparecen pero que NO están en los candidatos → invención
  // 2) URLs que aparecen MÁS DE UNA VEZ → duplicación entre secciones
  const validUrls = new Set<string>();
  for (const cands of Object.values(candidatesByAreaLevel)) {
    for (const c of cands) if (c.url_short) validUrls.add(c.url_short);
  }

  const urlPattern = /https?:\/\/[^\s)]+/g;
  const foundUrls = fullMessage.match(urlPattern) || [];
  const inventedUrls = foundUrls.filter(u => !validUrls.has(u));
  const urlCounts = new Map<string, number>();
  for (const u of foundUrls) urlCounts.set(u, (urlCounts.get(u) || 0) + 1);
  const duplicateUrls = [...urlCounts.entries()].filter(([_, c]) => c > 1).map(([u]) => u);

  if (inventedUrls.length > 0) {
    console.warn(`[weekly] URLs INVENTADAS detectadas (${inventedUrls.length}):`, inventedUrls.slice(0, 5));
  }
  if (duplicateUrls.length > 0) {
    console.warn(`[weekly] URLs DUPLICADAS detectadas (${duplicateUrls.length}):`, duplicateUrls.slice(0, 5));
  }

  if (inventedUrls.length > 0 || duplicateUrls.length > 0) {
    const issues: string[] = [];
    if (inventedUrls.length > 0) issues.push(`${inventedUrls.length} link(s) inventado(s) por la IA`);
    if (duplicateUrls.length > 0) issues.push(`${duplicateUrls.length} link(s) duplicado(s) entre secciones`);
    fullMessage += `\n\n⚠️ *Aviso de calidad*: ${issues.join(' y ')} — revisar antes de reenviar a WhatsApp.`;
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Notas de aprendizaje (cortas)
  let learningNotes = '';
  try {
    const learningPrompt = `Analizás brevemente este boletín semanal recién generado:\n${fullMessage.substring(0, 1500)}\n\nGenerá 3 notas de aprendizaje sobre qué se podría mejorar (formato lista, 200 palabras máximo).`;
    const { text } = await callGemini(GEMINI_API_KEY, 'Sos un editor crítico. Castellano rioplatense.', learningPrompt, 800);
    learningNotes = text;
  } catch {
    learningNotes = 'Sin notas de aprendizaje en este ciclo.';
  }

  // Guardar en DB
  const { data: digest, error: digestErr } = await supabase
    .from('digest_sends')
    .insert({
      telegram_message: fullMessage,
      articles_count: articlesFiltered.length,
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
      articles_count: articlesFiltered.length,
      candidates_count: totalCandidates,
      candidates_by_cell: candidateStats,
      message_length: fullMessage.length,
      models_used: [r1.modelUsed],
    }),
    { headers: corsHdrs }
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MÓDULO: BOLETÍN LUNES — "La única verdad es la realidad"
// ═════════════════════════════════════════════════════════════════════════════
// Temas centrales de la última semana en Argentina, con clustering por
// keywords (varios medios cubriendo el mismo tema → una sola entrada con
// múltiples links) y boost por firmas del dataset de periodistas.

// Stopwords castellano + términos genéricos a ignorar al armar clusters
const CLUSTERING_STOPWORDS = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','al','a','y','o',
  'en','con','por','para','sobre','sin','entre','que','se','su','sus','este',
  'esta','estos','estas','ese','esa','esos','esas','aquel','aquella','aquellos',
  'aquellas','lo','le','les','me','te','nos','vos','tu','mi','ya','no','si',
  'ni','muy','mas','mucho','más','menos','también','pero','aunque','cuando',
  'mientras','donde','como','así','ante','tras','desde','hasta','según','vs',
  'foto','video','en vivo','tras','últimas','noticias','noticia','hoy','ayer',
  'mañana','semana','mes','año','dia','día','información','información',
  // Argentinismos comunes que aparecen siempre y no aportan
  'argentina','argentino','argentinos','argentinas','milei','gobierno','presidente',
]);

function extractKeywords(text: string): string[] {
  // Normalizar
  const norm = (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s-]/g, ' ');
  const tokens = norm.split(/\s+/).filter(t => t.length >= 5 && !CLUSTERING_STOPWORDS.has(t));
  // Solo tokens "significativos" (longitud >= 5)
  return [...new Set(tokens)];
}

interface RawArticle {
  title: string;
  summary: string;
  url: string;
  url_short: string;
  scraped_at: string;
  source_name: string;
  level: GeoLevel | 'unknown';
  // Campos derivados:
  keywords: string[];
  journalist: Periodista | null;
  score: number;
}

interface Cluster {
  // Representante: el artículo más reciente del cluster
  representative: RawArticle;
  // Todos los artículos del cluster (incluye al representante)
  articles: RawArticle[];
  // Score agregado del cluster (suma de scores de cada artículo)
  totalScore: number;
  // Keywords compartidas (intersección de los más recientes)
  commonKeywords: string[];
}

function clusterArticles(articles: RawArticle[]): Cluster[] {
  // Algoritmo simple: dos artículos están en el mismo cluster si comparten
  // al menos 2 keywords significativas. Iteramos en orden de fecha (más
  // reciente primero) y vamos agregando.
  const sorted = [...articles].sort(
    (a, b) => new Date(b.scraped_at).getTime() - new Date(a.scraped_at).getTime()
  );

  const clusters: Cluster[] = [];

  for (const art of sorted) {
    let assigned = false;
    for (const c of clusters) {
      const shared = art.keywords.filter(k => c.commonKeywords.includes(k));
      if (shared.length >= 2) {
        c.articles.push(art);
        c.totalScore += art.score;
        // Recalcular commonKeywords: intersección
        c.commonKeywords = c.commonKeywords.filter(k => art.keywords.includes(k));
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({
        representative: art,
        articles: [art],
        totalScore: art.score,
        commonKeywords: [...art.keywords],
      });
    }
  }

  // Para cada cluster, asegurar que el representante sea el más reciente
  // (ya lo es por orden de iteración pero por las dudas):
  for (const c of clusters) {
    c.articles.sort((a, b) =>
      new Date(b.scraped_at).getTime() - new Date(a.scraped_at).getTime()
    );
    c.representative = c.articles[0];
  }

  return clusters;
}

function scoreArticle(art: RawArticle): number {
  // Base: 1
  let score = 1.0;
  // Boost por firma reconocida
  if (art.journalist) {
    score += orientationScore(art.journalist.orientacion);
  }
  // Boost leve si tiene resumen sustantivo (no solo título)
  if (art.summary && art.summary.length > 80) score += 0.3;
  return score;
}

async function handleMondayRealidad(
  supabase: any,
  GEMINI_API_KEY: string,
  scheduleName: string
): Promise<Response> {
  const corsHdrs = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };

  try {
    return await runMondayRealidad(supabase, GEMINI_API_KEY, scheduleName, corsHdrs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error('[monday] Crash:', msg);
    if (stack) console.error('[monday] Stack:', stack);
    return new Response(
      JSON.stringify({
        success: false,
        error: msg,
        step: 'monday_handler',
        stack: stack ? stack.substring(0, 500) : undefined,
      }),
      { status: 500, headers: corsHdrs }
    );
  }
}

async function runMondayRealidad(
  supabase: any,
  GEMINI_API_KEY: string,
  scheduleName: string,
  corsHdrs: Record<string, string>
): Promise<Response> {
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

  // Filtro de páginas de sección/agenda (mismo isLikelySectionPage del weekly)
  const isLikelySectionPage = (a: any): boolean => {
    const url = (a.url || '').toLowerCase();
    const title = (a.title || '').toLowerCase().trim();
    if (/\/(category|categoria|categorias|seccion|secciones|sección|tag|tags|agenda|todos|todas|archivo|archivos)\b/.test(url)) return true;
    const pathSegments = url.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
    if (pathSegments.length <= 1) return true;
    const genericTitles = [
      /^(cultura|educaci[oó]n|salud|g[eé]nero|pol[ií]tica|deportes|sociedad|econom[ií]a)\s*[-|–—]/i,
      /archivos?$/i,
      /^agenda\b/i,
      /\bsecci[oó]n\b/i,
      /\bcategor[ií]a\b/i,
      /^novedades$/i,
    ];
    if (genericTitles.some(re => re.test(title))) return true;
    if (title.length < 25) return true;
    return false;
  };

  const articlesFiltered = articles.filter((a: any) => !isLikelySectionPage(a));
  console.log(`[monday] Filtrados (sección): ${articles.length - articlesFiltered.length}, restantes: ${articlesFiltered.length}`);

  if (articlesFiltered.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: 'Sin artículos válidos tras el filtro' }),
      { headers: corsHdrs }
    );
  }

  // Acortar URLs
  const allUrls = articlesFiltered.map((a: any) => a.url).filter(Boolean);
  const shortUrlMap = await shortenAll(allUrls);

  // Enriquecer cada artículo con campos derivados
  const enriched: RawArticle[] = articlesFiltered.map((a: any) => {
    const sourceName = a.media_sources?.name || '?';
    const journalist = detectJournalist(a.title || '', a.summary || '', sourceName);
    const level = detectGeoLevel(a);
    const keywords = extractKeywords(`${a.title} ${a.summary}`);
    const obj: RawArticle = {
      title: a.title || '',
      summary: (a.summary || '').substring(0, 300),
      url: a.url || '',
      url_short: shortUrlMap.get(a.url) || a.url || '',
      scraped_at: a.scraped_at,
      source_name: sourceName,
      level,
      keywords,
      journalist,
      score: 0,
    };
    obj.score = scoreArticle(obj);
    return obj;
  });

  // Filtros: solo Argentina, descartar 'unknown' (probablemente extranjero)
  const onlyArgentina = enriched.filter(a => a.level !== 'unknown');

  console.log(`[monday] Artículos AR (national+provincial+municipal): ${onlyArgentina.length}`);

  // Clustering por nivel
  const byLevel = {
    national: onlyArgentina.filter(a => a.level === 'national'),
    provincial: onlyArgentina.filter(a => a.level === 'provincial'),
    municipal: onlyArgentina.filter(a => a.level === 'municipal'),
  };

  const clustersNat = clusterArticles(byLevel.national);
  const clustersProv = clusterArticles(byLevel.provincial);
  const clustersMun = clusterArticles(byLevel.municipal);

  // Ordenar clusters por totalScore desc y tomar topN
  const TOP_NAT = 4;
  const TOP_PROV = 2;
  const TOP_MUN = 2;
  clustersNat.sort((a, b) => b.totalScore - a.totalScore);
  clustersProv.sort((a, b) => b.totalScore - a.totalScore);
  clustersMun.sort((a, b) => b.totalScore - a.totalScore);
  const topNat = clustersNat.slice(0, TOP_NAT);
  const topProv = clustersProv.slice(0, TOP_PROV);
  const topMun = clustersMun.slice(0, TOP_MUN);

  console.log(`[monday] Clusters: nacional=${clustersNat.length} (top ${topNat.length}), provincial=${clustersProv.length} (top ${topProv.length}), municipal=${clustersMun.length} (top ${topMun.length})`);

  if (topNat.length === 0 && topProv.length === 0 && topMun.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: 'No hay clusters relevantes esta semana' }),
      { headers: corsHdrs }
    );
  }

  // Fecha
  const nowAR = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const dateLong = `${dayNames[nowAR.getUTCDay()]} ${nowAR.getUTCDate()} de ${monthNames[nowAR.getUTCMonth()]} de ${nowAR.getUTCFullYear()}`;
  const dateShort = `${String(nowAR.getUTCDate()).padStart(2, '0')}/${String(nowAR.getUTCMonth() + 1).padStart(2, '0')}`;

  // Armar prompt: cada cluster se presenta con representante (más reciente) +
  // hasta 4 fuentes alternativas para que Gemini elija las mejores 2-3 miradas.
  const formatCluster = (c: Cluster, idx: number): string => {
    const rep = c.representative;
    const others = c.articles.slice(1, 5); // hasta 4 fuentes alternativas
    let txt = `\n[Cluster ${idx + 1}] (score=${c.totalScore.toFixed(1)}, ${c.articles.length} fuentes)\n`;
    txt += `  Más reciente: "${rep.title}" | ${rep.source_name}`;
    if (rep.journalist) txt += ` (firma: ${rep.journalist.firma}, ${rep.journalist.orientacion})`;
    txt += `\n    URL: ${rep.url_short}\n    Resumen: ${rep.summary}\n`;
    if (others.length > 0) {
      txt += `  Otras fuentes del mismo tema:\n`;
      for (const o of others) {
        txt += `    - "${o.title}" | ${o.source_name}`;
        if (o.journalist) txt += ` (${o.journalist.orientacion})`;
        txt += ` | ${o.url_short}\n`;
      }
    }
    return txt;
  };

  const buildClustersBlock = (clusters: Cluster[], levelLabel: string): string => {
    if (clusters.length === 0) return `\n[${levelLabel}: sin material esta semana — OMITIR esta sección]\n`;
    return `\n[${levelLabel}: ${clusters.length} cluster(s)]\n` + clusters.map(formatCluster).join('\n');
  };

  const systemPrompt = `Sos el editor del boletín lunes "La única verdad es la realidad" de Patria Grande Quilmes, una organización peronista y popular argentina.

El boletín del lunes recapitula los temas centrales de la última semana en Argentina, ordenados en 3 bloques: Nacional, Provincial (Buenos Aires) y Local (Quilmes).

REGLAS DEL ENVÍO:
- Lenguaje militante peronista pero ACCESIBLE — para simpatizantes con contexto político medio.
- Tono concreto y directo. Que se note el posicionamiento sin caer en consigna vacía.
- Perspectiva de género NATURAL: cuando el tema lo amerita, no forzada.
- Puntuación castellana correcta: ¡! y ¿? donde corresponda.

CONTENIDO POR NOTA:
- Cada nota debe basarse FIELMENTE en el título y resumen del cluster que te paso. NO inventes detalles que no estén ahí.
- 2 oraciones máximo por nota.
- Usar el url_short EXACTO de las fuentes del cluster. NO modificar.
- Para cada nota, incluir 2-3 links de medios DISTINTOS del mismo cluster (la idea es mostrar diferentes miradas del mismo hecho). Si un cluster solo tiene 1 fuente, va con 1 link.

REGLAS DE GEOGRAFÍA ESTRICTA:
- 🇦🇷 NACIONAL: SOLO temas que afectan al país. NO temas internacionales.
- 🏛️ PROVINCIAL: SOLO Provincia de Buenos Aires.
- 📍 LOCAL: SOLO el partido de Quilmes (no otros distritos).

REGLAS ABSOLUTAS:
1. Solo usar URLs que aparezcan en los clusters que te paso.
2. NO repetir la misma URL entre secciones (cada link aparece una sola vez en todo el boletín).
3. Si una sección no tiene clusters, OMITILA enteramente — no rellenar con material forzado.
4. NO inventes que "Patria Grande hizo X" si eso no aparece en los artículos.

ESTRUCTURA EXACTA del boletín que tenés que generar:

🗞️ *LA ÚNICA VERDAD ES LA REALIDAD*
📅 ${dateLong}

━━━━━━━━━━━━━━━━━
🔗 LO QUE PASÓ ESTA SEMANA
━━━━━━━━━━━━━━━━━
[2-3 oraciones de panorama integrador. Conectá los temas principales sin inventar. Tono concreto.]

━━━━━━━━━━━━━━━━━
🇦🇷 NACIONAL
━━━━━━━━━━━━━━━━━
▪️ *[Título del tema]*
[2 oraciones: qué pasó esta semana + por qué importa. Si el tema tuvo evolución, mencionar la última novedad.]
🔗 [link1] (Medio1) · [link2] (Medio2) · [link3] (Medio3)

[Hasta ${TOP_NAT} temas nacionales en total]

━━━━━━━━━━━━━━━━━
🏛️ PROVINCIAL (BUENOS AIRES)
━━━━━━━━━━━━━━━━━
▪️ *[Título]*
[2 oraciones]
🔗 [links]

[Hasta ${TOP_PROV} temas provinciales]

━━━━━━━━━━━━━━━━━
📍 LOCAL (QUILMES)
━━━━━━━━━━━━━━━━━
▪️ *[Título]*
[1-2 oraciones]
🔗 [links]

[Hasta ${TOP_MUN} temas locales]

━━━━━━━━━━━━━━━━━
✌️🇦🇷 *Patria Grande* | Lun ${dateShort} — 20:00`;

  const userPrompt = `Generá el boletín lunes "La única verdad es la realidad" con los siguientes clusters de noticias de la última semana.

Cada cluster representa un mismo TEMA cubierto por varios medios. El "Más reciente" es el que mejor refleja la última novedad. Las "Otras fuentes" son del mismo tema en otros medios — usalas para dar diferentes miradas en cada nota (2-3 links por nota cuando sea posible).

Las firmas marcadas como (peronista) o (progresista) o (independiente_critico) tienen prioridad en la selección de fuentes. (conservador) puede usarse para mostrar la mirada del adversario, pero no debe ser la única fuente.

${buildClustersBlock(topNat, 'NACIONAL')}
${buildClustersBlock(topProv, 'PROVINCIAL')}
${buildClustersBlock(topMun, 'LOCAL_QUILMES')}

Generá ahora el boletín completo siguiendo la estructura del system prompt. No agregues texto antes ni después de la estructura.`;

  console.log(`[${scheduleName}] Generando boletín lunes con ${topNat.length + topProv.length + topMun.length} clusters totales`);

  const r1 = await callGemini(GEMINI_API_KEY, systemPrompt, userPrompt, 10000);
  let fullMessage = r1.text.trim();

  console.log(`[${scheduleName}] Modelo usado: ${r1.modelUsed}`);
  console.log(`[${scheduleName}] Longitud final: ${fullMessage.length} chars`);

  // ── Validación post-Gemini (mismo patrón del weekly) ─────────────────────
  const validUrls = new Set<string>();
  for (const c of [...topNat, ...topProv, ...topMun]) {
    for (const a of c.articles) if (a.url_short) validUrls.add(a.url_short);
  }

  const urlPattern = /https?:\/\/[^\s)]+/g;
  const foundUrls = (fullMessage.match(urlPattern) || []).map(u => u.replace(/[.,;:!?)]+$/, ''));
  const inventedUrls = foundUrls.filter(u => !validUrls.has(u));
  const urlCounts = new Map<string, number>();
  for (const u of foundUrls) urlCounts.set(u, (urlCounts.get(u) || 0) + 1);
  const duplicateUrls = [...urlCounts.entries()].filter(([_, c]) => c > 1).map(([u]) => u);

  if (inventedUrls.length > 0) {
    console.warn(`[monday] URLs INVENTADAS (${inventedUrls.length}):`, inventedUrls.slice(0, 5));
  }
  if (duplicateUrls.length > 0) {
    console.warn(`[monday] URLs DUPLICADAS (${duplicateUrls.length}):`, duplicateUrls.slice(0, 5));
  }
  if (inventedUrls.length > 0 || duplicateUrls.length > 0) {
    const issues: string[] = [];
    if (inventedUrls.length > 0) issues.push(`${inventedUrls.length} link(s) inventado(s) por la IA`);
    if (duplicateUrls.length > 0) issues.push(`${duplicateUrls.length} link(s) duplicado(s) entre secciones`);
    fullMessage += `\n\n⚠️ *Aviso de calidad*: ${issues.join(' y ')} — revisar antes de reenviar.`;
  }

  // Notas de aprendizaje (cortas)
  let learningNotes = '';
  try {
    const learningPrompt = `Analizá brevemente el boletín lunes recién generado:\n${fullMessage.substring(0, 1500)}\n\nGenerá 3 notas de aprendizaje sobre qué se podría mejorar en próximos boletines lunes (formato lista, 200 palabras máximo).`;
    const { text } = await callGemini(GEMINI_API_KEY, 'Sos un editor crítico. Castellano rioplatense.', learningPrompt, 800);
    learningNotes = text;
  } catch {
    learningNotes = 'Sin notas de aprendizaje en este ciclo.';
  }

  // Guardar en DB
  const { data: digest, error: digestErr } = await supabase
    .from('digest_sends')
    .insert({
      telegram_message: fullMessage,
      articles_count: articlesFiltered.length,
      status: 'pending',
      digest_type: 'monday_realidad',
      learning_notes: learningNotes,
    })
    .select()
    .single();

  if (digestErr) throw digestErr;

  return new Response(
    JSON.stringify({
      success: true,
      digest_id: digest.id,
      digest_type: 'monday_realidad',
      articles_count: articlesFiltered.length,
      clusters: {
        nacional_total: clustersNat.length,
        nacional_top: topNat.length,
        provincial_total: clustersProv.length,
        provincial_top: topProv.length,
        municipal_total: clustersMun.length,
        municipal_top: topMun.length,
      },
      message_length: fullMessage.length,
      models_used: [r1.modelUsed],
      duplicates_detected: duplicateUrls.length,
      invented_detected: inventedUrls.length,
    }),
    { headers: corsHdrs }
  );
}
