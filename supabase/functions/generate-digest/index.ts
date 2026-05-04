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
    const l