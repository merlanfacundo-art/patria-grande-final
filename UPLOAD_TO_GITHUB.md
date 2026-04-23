# Cómo subir este proyecto a GitHub

## Opción A — Actualizar el repo existente `peronista-agenda-daily`

Esta opción reemplaza el contenido del repo actual con esta versión nueva.

```bash
# 1. Extraer el ZIP en una carpeta limpia
unzip patria-grande-final.zip -d ~/patria-grande
cd ~/patria-grande

# 2. Clonar el repo actual en otra carpeta temporal
cd /tmp
git clone https://github.com/merlanfacundo-art/peronista-agenda-daily.git
cd peronista-agenda-daily

# 3. Borrar TODO excepto .git (para empezar limpio)
find . -mindepth 1 -not -path './.git*' -delete

# 4. Copiar los nuevos archivos
cp -r ~/patria-grande/. .

# 5. Commit y push
git add -A
git commit -m "v1: desacoplar Lovable, migrar a stack autónomo

- Edge Functions ahora usan Gemini API directa (sin ai.gateway.lovable.dev)
- Telegram Bot API directa (sin connector-gateway.lovable.dev)
- Google News RSS primario para scraping (gratis ilimitado), Firecrawl fallback
- TinyURL para acortar links
- Dos prompts diferenciados: resumen personal (07:00 y 13:00) + boletín grupal (20:00)
- Aprendizaje entre envíos con learning_notes
- Perspectiva de género obligatoria en prompt y detección por keywords
- Panel admin con CRUD completo de fuentes y periodistas
- pg_cron con 3 schedules automáticos
- Seed de 41 fuentes + 6 periodistas de referencia"

git push origin main
```

## Opción B — Crear un repo nuevo (recomendado si querés conservar la versión anterior)

```bash
# 1. Crear el repo en GitHub desde la web:
#    https://github.com/new
#    Nombre sugerido: patria-grande-boletin
#    Privado (recomendado, porque los seeds incluyen lista de medios)

# 2. Extraer el ZIP y entrar a la carpeta
unzip patria-grande-final.zip -d ~/patria-grande-boletin
cd ~/patria-grande-boletin

# 3. Inicializar git y hacer el primer commit
git init
git add -A
git commit -m "Initial commit: Patria Grande boletín v1"

# 4. Conectar con el repo remoto
git branch -M main
git remote add origin https://github.com/merlanfacundo-art/patria-grande-boletin.git
git push -u origin main
```

## Opción C — Subir a mano desde la interfaz web de GitHub

Si preferís evitar la terminal:

1. Extraer el ZIP
2. En GitHub, crear un repo nuevo (o ir al existente)
3. Hacer clic en "uploading an existing file"
4. Arrastrar **todo el contenido** de la carpeta (no la carpeta en sí)
5. Commit directamente desde la web

**Limitación**: GitHub web no permite subir carpetas anidadas fácilmente, así que para este proyecto (que tiene carpetas profundas como `supabase/functions/...`) la Opción A o B es mucho mejor.

## Verificaciones post-upload

Después de subir:

1. Chequear que `.env` NO esté en el repo (debería estar ignorado por `.gitignore`)
2. Chequear que `node_modules/` NO esté
3. Verificar que se vea el README renderizado en la portada del repo
4. Si el repo es privado, compartir acceso a quien necesite colaborar

## Secrets que NO deben subirse

Asegurate de que estos NUNCA queden en el repo:

- API keys reales (Gemini, Firecrawl, Supabase service_role_key)
- Tokens de Telegram
- `.env` completo

Los secrets reales se configuran en:
- **Local** (desarrollo): archivo `.env` (ignorado por git)
- **Producción** (Edge Functions): Supabase dashboard → Edge Functions → Secrets
- **Frontend build**: solo `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (que son públicos por diseño)
