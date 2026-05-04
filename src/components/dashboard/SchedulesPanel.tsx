import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Clock, Info } from "lucide-react";

// Mapeo de schedule name → tipo
const scheduleTypeMap: Record<string, { type: "personal" | "group" | "weekly" | "monday_realidad"; emoji: string }> = {
  "Resumen 07:00":  { type: "personal",          emoji: "📋" },
  "Resumen 13:00":  { type: "personal",          emoji: "📋" },
  "Boletín 20:00":  { type: "group",             emoji: "🗞️" },
  "Lunes Realidad": { type: "monday_realidad",   emoji: "🗞️" },
  "Martes Áreas":   { type: "weekly",            emoji: "⚽" },
};

export function SchedulesPanel() {
  const qc = useQueryClient();

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["digest_schedules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("digest_schedules")
        .select("*")
        .order("cron_expression");
      if (error) throw error;
      return data;
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("digest_schedules").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["digest_schedules"] }),
  });

  if (isLoading) return <p className="text-muted-foreground">Cargando horarios...</p>;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Horarios de envío</h2>

      <Card className="bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <CardContent className="pt-4 pb-3 flex items-start gap-3">
          <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
          <div className="text-sm text-blue-900 dark:text-blue-100">
            <p className="font-medium">Schedules programados con pg_cron</p>
            <p className="text-xs mt-1">
              Los horarios están en UTC en la expresión cron, pero se disparan en hora Argentina.
              Para pausar un horario, desactivá el switch (solo afecta al registro, pg_cron sigue ejecutándose
              según la migration; para pausarlo completamente desde la DB hay que correr <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">cron.unschedule()</code>).
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {(schedules || []).map((s: any) => {
          const meta = scheduleTypeMap[s.name] || { type: "group", emoji: "📨" };
          return (
            <Card key={s.id} className={s.is_active ? "" : "opacity-60"}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <Clock className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground">
                        {meta.emoji} {s.name}
                      </p>
                      <p className="text-sm text-muted-foreground">{s.description}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{s.cron_expression}</code>
                        <Badge variant="outline" className="text-xs">
                          {
                            meta.type === "personal" ? "Solo a Facu" :
                            meta.type === "weekly" ? "Martes — Grupo" :
                            meta.type === "monday_realidad" ? "Lunes — Grupo" :
                            "Grupo WhatsApp"
                          }
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={s.is_active}
                    onCheckedChange={(v) => toggleActive.mutate({ id: s.id, is_active: v })}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
