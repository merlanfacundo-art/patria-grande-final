import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Convierte el formato de Gemini (Markdown simple) a HTML de Telegram.
// HTML es más tolerante que Markdown: no rompe por un * suelto.
// Cuando se copia/pega a WhatsApp, WhatsApp ignora las tags HTML y
// el texto queda limpio (los *asteriscos* de negrita se pierden, pero
// el contenido y la estructura se mantienen).
function toTelegramHTML(text: string): string {
  // Escapar primero los caracteres HTML peligrosos
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Convertir *negrita* a <b>negrita</b>
  // Solo matchea pares completos, los asteriscos sueltos quedan como texto
  html = html.replace(/\*([^*\n]+?)\*/g, '<b>$1</b>');

  return html;
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  // Red de seguridad: si el mensaje no termina con el footer esperado,
  // agregamos un aviso al final para que sepamos que fue truncado.
  // El footer esperado termina con "Patria Grande | HH:MM" o similar.
  let safeText = text.trimEnd();
  const hasFooter = /🤖\s*Patria Grande/.test(safeText.slice(-200));
  if (!hasFooter) {
    safeText += '\n\n⚠️ [Mensaje truncado por límite de tokens. Revisar prompt.]\n🤖 Patria Grande';
  }

  // Partir el texto en chunks de hasta 4000 chars respetando saltos de línea
  const chunks: string[] = [];
  if (safeText.length <= 4096) {
    chunks.push(safeText);
  } else {
    let current = '';
    for (const line of safeText.split('\n')) {
      const candidate = current ? current + '\n' + line : line;
      if (candidate.length > 4000 && current.length > 0) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
  }

  for (const chunk of chunks) {
    const htmlText = toTelegramHTML(chunk);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Telegram API [${res.status}]: ${JSON.stringify(data)}`);
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN no configurado');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const body = await req.json().catch(() => ({}));
    const { digest_id, chat_id: bodyChatId, message } = body;

    // ── Modo directo: resúmenes personales (no se guardan en DB) ──────────────
    if (message && bodyChatId) {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, bodyChatId, message);
      return new Response(
        JSON.stringify({ success: true, mode: 'direct' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Modo DB: boletín grupal ───────────────────────────────────────────────
    let chat_id = bodyChatId;
    if (!chat_id) {
      const { data: cfg } = await supabase
        .from('digest_config')
        .select('value')
        .eq('key', 'telegram_group_chat_id')
        .single();
      chat_id = cfg?.value;
    }
    if (!chat_id) throw new Error('No telegram_group_chat_id configurado');

    let digestMessage: string;
    let resolvedId = digest_id;

    if (digest_id) {
      const { data, error } = await supabase
        .from('digest_sends').select('*').eq('id', digest_id).single();
      if (error || !data) throw new Error('Digest no encontrado');
      digestMessage = data.telegram_message || '';
    } else {
      const { data, error } = await supabase
        .from('digest_sends').select('*').eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(1).single();
      if (error || !data) throw new Error('No hay digest pendiente');
      resolvedId = data.id;
      digestMessage = data.telegram_message || '';
    }

    if (!digestMessage) throw new Error('Mensaje vacío');

    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chat_id, digestMessage);

    await supabase.from('digest_sends')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', resolvedId);

    return new Response(
      JSON.stringify({ success: true, mode: 'db', digest_id: resolvedId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error send-telegram:', error);
    try {
      const b = await req.clone().json().catch(() => ({}));
      if (b.digest_id) {
        const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        await sb.from('digest_sends')
          .update({ status: 'failed', error_message: error instanceof Error ? error.message : 'Unknown' })
          .eq('id', b.digest_id);
      }
    } catch { /* silencioso */ }

    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
