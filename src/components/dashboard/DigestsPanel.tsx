import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Play, Send, Copy, Loader2, Lightbulb, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

export function DigestsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedLearning, setExpandedLearning] = useState<Set<string>>(new Set());

  const { data: digests, isLoading } = useQuery({
    queryKey: ["digest_sends"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("digest_sends")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
    refetchInterval: 10000,
  });

  const runPipeline = useMutation({
    mutationFn: async (type: "personal" | "group") => {
      const scheduleName = type === "personal" ? "Manual Personal" : "Manual";
      const { data, error } = await supabase.functions.invoke("run-digest-pipeline", {
        body: { schedule_name: scheduleName, digest_type: type },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Pipeline ejecutado",
        description: `${data.scraped || 0} notas scrapeadas, ${data.articles_in_digest || 0} en el digest`,
      });
      queryClient.invalidateQueries({ queryKey: ["digest_sends"] });
    },
    onError: (err) => toast({ title: "Error", description: (err as Error).message, variant: "destructive" }),
  });

  const sendDigest = useMutation({
    mutationFn: async (digestId: string) => {
      const { data, error } = await supabase.functions.invoke("send-telegram", {
        body: { digest_id: digestId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Enviado", description: "Digest enviado por Telegram" });
      queryClient.invalidateQueries({ queryKey: ["digest_sends"] });
    },
    onError: (err) => toast({ title: "Error al enviar", description: (err as Error).message, variant: "destructive" }),
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copiado", description: "Texto copiado al portapapeles" });
  };

  const toggleLearning = (id: string) => {
    setExpandedLearning(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    sent: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Envíos de resúmenes</h2>
        <div className="flex gap-2">
          <Button
            onClick={() => runPipeline.mutate("personal")}
            disabled={runPipeline.isPending}
            size="sm"
            variant="outline"
          >
            {runPipeline.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
            Resumen personal
          </Button>
          <Button
            onClick={() => runPipeline.mutate("group")}
            disabled={runPipeline.isPending}
            size="sm"
          >
            {runPipeline.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
            Boletín grupal
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Los resúmenes personales van solo a tu Telegram y no se guardan acá. Los boletines grupales se guardan y se envían al grupo.
      </p>

      {isLoading && <p className="text-muted-foreground">Cargando...</p>}

      <div className="space-y-3">
        {(digests || []).map((d: any) => (
          <Card key={d.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">
                  {new Date(d.created_at).toLocaleString("es-AR")}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {d.digest_type && (
                    <Badge variant="outline" className="text-xs">
                      {d.digest_type === "personal" ? "📋 personal" : "🗞️ grupal"}
                    </Badge>
                  )}
                  <Badge className={statusColors[d.status] || ""}>{d.status}</Badge>
                  <span className="text-xs text-muted-foreground">{d.articles_count} notas</span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {d.telegram_message && (
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted p-3 rounded max-h-48 overflow-auto font-sans">
                  {d.telegram_message}
                </pre>
              )}
              {d.error_message && <p className="text-xs text-destructive mt-2">{d.error_message}</p>}

              {d.learning_notes && (
                <div className="mt-3 border-l-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 pl-3 py-2 rounded-r">
                  <button
                    onClick={() => toggleLearning(d.id)}
                    className="flex items-center gap-1.5 text-xs font-medium text-yellow-800 dark:text-yellow-300 hover:underline"
                  >
                    <Lightbulb className="h-3.5 w-3.5" />
                    Aprendizajes del ciclo
                    {expandedLearning.has(d.id) ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                  {expandedLearning.has(d.id) && (
                    <pre className="text-xs text-yellow-900 dark:text-yellow-200 whitespace-pre-wrap mt-2 font-sans">
                      {d.learning_notes}
                    </pre>
                  )}
                </div>
              )}

              <div className="flex gap-2 mt-3">
                {d.status === "pending" && (
                  <Button size="sm" variant="outline" onClick={() => sendDigest.mutate(d.id)} disabled={sendDigest.isPending}>
                    <Send className="h-3.5 w-3.5 mr-1" /> Enviar por Telegram
                  </Button>
                )}
                {d.telegram_message && (
                  <Button size="sm" variant="ghost" onClick={() => copyToClipboard(d.telegram_message)}>
                    <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {!isLoading && (!digests || digests.length === 0) && (
          <p className="text-muted-foreground text-center py-8">
            No hay envíos todavía. Hacé clic en "Boletín grupal" para generar el primer boletín.
          </p>
        )}
      </div>
    </div>
  );
}
