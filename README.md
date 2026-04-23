# 🗞️ Patria Grande — Boletín militante automatizado

Sistema automatizado para generar y distribuir un boletín político diario con perspectiva peronista y de género, destinado a simpatizantes y militantes de la organización Patria Grande.

## ¿Qué hace?

- **07:00 ART** — Resumen personal completo al Telegram del responsable de comunicación (no se guarda)
- **13:00 ART** — Resumen personal de actualización al mediodía (no se guarda)
- **20:00 ART** — Boletín grupal accesible (300-400 palabras) enviado automáticamente al grupo de Telegram → se reenvía a mano a WhatsApp

Monitorea ~40 fuentes periodísticas (nacionales, internacionales, medios afines, centros de estudio) y usa Gemini para armar un resumen con:
- Panorama integrador inicial que conecta los temas del día
- Top de temas nacionales, internacionales y "fuera de agenda mediática"
- Sección de análisis con novedades de Cenital, Anfibia, CEPA, El Cohete, Panamá Revista, Va con Firma, Kranear, y periodistas de referencia (Tokatlian, Genoud, Zaiat, Verbitsky, etc.)
- Links acortados con TinyURL
- Perspectiva de género en toda la redacción
- Comparación con el envío anterior y aprendizaje continuo entre ciclos

## Stack técnico

Todo el sistema corre con **herramientas 100% gratuitas**:

| Componente | Tecnología | Plan |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript | - |
| UI | Tailwind + shadcn/ui | - |
| Base de datos | Supabase (Postgres) | Free |
| Backend | Supabase Edge Functions (Deno) | Free |
| IA | Google Gemini 2.5 Flash | Free tier |
| Scraping primario | Google News RSS | Gratis ilimitado |
| Scraping fallback | Firecrawl | Free (500/mes) |
| Mensajería | Telegram Bot API | Gratis |
| Acortador | TinyURL API | Gratis sin auth |
| Scheduling | pg_cron | Incluido en Supabase |

## Arquitectura

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────┐
│   pg_cron   │───▶│ run-digest-      │───▶│ scrape-news  │
│ (3 horarios)│    │  pipeline        │    └──────┬───────┘
└─────────────┘    └──────────────────┘           │
                           │                       ▼
                           │              ┌──────────────┐
                           │              │ Google News  │
                           │              │ RSS + Firecrawl
                           │              └──────┬───────┘
                           │                       │
                           ▼                       ▼
                   ┌──────────────────┐    ┌──────────────┐
                   │ generate-digest  │◀───│ scraped_     │
                   │ (Gemini)         │    │ articles DB  │
                   └──────────┬───────┘    └──────────────┘
                              │
                              ▼
                   ┌──────────────────┐
                   │ send-telegram    │
                   │ (Bot API)        │
                   └──────────────────┘
```

## Setup desde cero

### 1. Crear proyecto Supabase (gratis)

1. Ir a [supabase.com](https://supabase.com) y crear un proyecto nuevo
2. Copiar **Project URL** y **service_role key** desde Settings → API

### 2. Crear bot de Telegram (gratis)

1. Hablar con [@BotFather](https://t.me/BotFather) y crear un bot con `/newbot`
2. Guardar el **token** que te devuelve
3. Obtener tu **chat_id personal**: escribirle a [@userinfobot](https://t.me/userinfobot) y te responde con tu ID
4. Crear un grupo en Telegram para el boletín grupal, agregar el bot como admin, escribir cualquier mensaje, y visitar:
   `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` para ver el `chat.id` del grupo (empieza con `-`)

### 3. Obtener API key de Gemini (gratis)

1. Ir a [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Crear API key
3. El free tier alcanza largo para el uso del sistema

### 4. Configurar `.env`

Copiar `.env.example` a `.env` y completar:

```bash
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 5. Configurar secrets en Supabase

En el dashboard de Supabase, ir a **Edge Functions → Settings → Secrets** y agregar:

```
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=AIza...
TELEGRAM_BOT_TOKEN=123456:AAA...
TELEGRAM_PERSONAL_CHAT_ID=123456789
FIRECRAWL_API_KEY=fc-...   # opcional, fallback
```

### 6. Aplicar migrations

```bash
npm install -g supabase
supabase login
supabase link --project-ref TU-PROJECT-REF
supabase db push
```

Esto crea todas las tablas, carga las ~40 fuentes, los 6 periodistas de referencia y los 3 schedules.

### 7. Configurar variables de pg_cron

En el **SQL Editor** de Supabase, ejecutar una sola vez:

```sql
ALTER DATABASE postgres SET app.supabase_url = 'https://TU-PROYECTO.supabase.co';
ALTER DATABASE postgres SET app.service_role_key = 'TU_SERVICE_ROLE_KEY';
```

### 8. Guardar chat_id del grupo en config

En el SQL Editor:

```sql
INSERT INTO digest_config (key, value, description)
VALUES ('telegram_group_chat_id', '-100123456789', 'Chat ID del grupo de Telegram')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

### 9. Desplegar Edge Functions

```bash
supabase functions deploy scrape-news
supabase functions deploy generate-digest
supabase functions deploy send-telegram
supabase functions deploy run-digest-pipeline
```

### 10. Correr el frontend

```bash
npm install
npm run dev
```

Abrir [http://localhost:8080](http://localhost:8080) — deberías ver el panel.

### 11. Primer test

Desde el panel, tab **Envíos**, hacer clic en **"Boletín grupal"**. Esperar ~30-60 segundos. Debería:
1. Scrapear todas las fuentes activas
2. Generar un boletín con Gemini
3. Guardarlo en `digest_sends` con status `pending`
4. Enviarlo al grupo de Telegram
5. Actualizar el status a `sent`

Si algo falla, revisar logs en Supabase → Edge Functions → Logs.

## Estructura del proyecto

```
├── src/
│   ├── components/dashboard/     # 4 paneles del admin
│   │   ├── DigestsPanel.tsx      # Envíos + learning notes
│   │   ├── SourcesPanel.tsx      # CRUD de medios
│   │   ├── JournalistsPanel.tsx  # CRUD de periodistas
│   │   ├── SchedulesPanel.tsx    # Horarios programados
│   │   └── ConfigPanel.tsx       # Config general
│   ├── integrations/supabase/    # Cliente y tipos
│   └── pages/Index.tsx           # Layout principal con tabs
│
└── supabase/
    ├── functions/
    │   ├── scrape-news/          # RSS + Firecrawl fallback
    │   ├── generate-digest/      # Gemini + TinyURL + aprendizaje
    │   ├── send-telegram/        # Bot API directa
    │   └── run-digest-pipeline/  # Orquestador
    │
    └── migrations/
        ├── 20260407055754_*.sql  # Schema inicial
        ├── 20260407061508_*.sql  # Reset used_in_digest
        ├── 20260422000001_*.sql  # learning_notes, digest_type, gender
        ├── 20260422000002_*.sql  # Seed 40 fuentes + periodistas
        └── 20260422000003_*.sql  # pg_cron schedules
```

## Uso

### Panel de administración

- **Envíos**: ejecutar pipeline manualmente (personal o grupal), ver historial, copiar mensajes, leer notas de aprendizaje del ciclo
- **Medios**: agregar/eliminar fuentes, activar/desactivar
- **Periodistas**: agregar periodistas de referencia con keywords; los artículos que los mencionan se priorizan en la sección de análisis
- **Horarios**: toggle de los schedules activos
- **Config**: keywords de detección (Argentina, Grabois, género)

### Lógica de aprendizaje entre ciclos

Cada boletín grupal genera automáticamente **notas de aprendizaje** que se incluyen en el prompt del siguiente envío. Esto permite que el sistema:
- Evite repetir temas ya tratados
- Mejore enfoque de género si quedó corto
- Ajuste el tono si fue demasiado técnico o demasiado simple

Las notas son visibles en el panel (desplegable en cada envío guardado).

## Filosofía del proyecto

- **Herramientas 100% gratuitas** de principio a fin
- **Perspectiva de género obligatoria** en toda la redacción
- **Calidad alta**: solo noticias con 2+ fuentes, no se incluyen noticias sin respaldo
- **Links siempre acortados** para legibilidad en WhatsApp
- **Lenguaje militante** pero accesible para simpatizantes de contexto político medio
- **Puntuación castellana** correcta (¡!, ¿?)
- **Mejora continua** explícita entre ciclos

## Mantenimiento

### Agregar una fuente nueva

Desde el panel → Medios → "Agregar medio". Elegir categoría y guardar. Quedará activa automáticamente y entrará al próximo scraping.

### Ajustar el prompt

Editar `supabase/functions/generate-digest/index.ts`:
- `buildPersonalSystemPrompt()` — para los resúmenes personales
- `buildGroupSystemPrompt()` — para el boletín grupal

Después redeployar: `supabase functions deploy generate-digest`.

### Desactivar un envío temporalmente

Desde el panel → Horarios → switch off. Nota: el toggle solo marca el registro, pg_cron sigue activo. Para pausarlo de verdad en DB:

```sql
SELECT cron.unschedule('patria-grande-07');
```

Para reactivarlo, volver a correr la migration `20260422000003`.

## Licencia

Uso interno de Patria Grande.
