import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const chunks: string[] = [];
  if (text.length <= 4096) {
    chunks.push(text);
  } else {
    let current = '';
    for (const line of text.split('\n')) {
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
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        // Sin parse_mode: enviamos texto plano. Motivo: Gemini a veces genera
        // asteriscos sueltos (*) que rompen el parser de Markdown de Telegram
        // con "Can't find end of the entity". WhatsApp interpreta los *negritas*
        // al pegar el texto, así que no perdemos nada en el destino final.
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
