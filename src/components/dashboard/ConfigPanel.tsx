import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Save } from "lucide-react";
import { useState, useEffect } from "react";

export function ConfigPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});

  const { data: config, isLoading } = useQuery({
    queryKey: ["digest_config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("digest_config")
        .select("*")
        .order("key");
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (config) {
      const vals: Record<string, string> = {};
      config.forEach((c) => { vals[c.key] = c.value; });
      setValues(vals);
    }
  }, [config]);

  const updateConfig = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { error } = await supabase
        .from("digest_config")
        .update({ value })
        .eq("key", key);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Guardado" });
      queryClient.invalidateQueries({ queryKey: ["digest_config"] });
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) return <p className="text-muted-foreground">Cargando configuración...</p>;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Configuración</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Parámetros del sistema</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(config || []).map((c) => (
            <div key={c.key} className="space-y-1.5">
              <Label className="text-sm font-medium">{c.key}</Label>
              {c.description && (
                <p className="text-xs text-muted-foreground">{c.description}</p>
              )}
              <div className="flex gap-2">
                <Input
                  value={values[c.key] || ""}
                  onChange={(e) => setValues({ ...values, [c.key]: e.target.value })}
                  className="text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateConfig.mutate({ key: c.key, value: values[c.key] || "" })}
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">¿Cómo obtener tu Chat ID de Telegram?</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>1. Buscá tu bot en Telegram y enviá <code className="bg-muted px-1 rounded">/start</code></p>
          <p>2. Abrí en el navegador: <code className="bg-muted px-1 rounded text-xs">https://api.telegram.org/bot&#123;TOKEN&#125;/getUpdates</code></p>
          <p>3. Buscá el campo <code className="bg-muted px-1 rounded">"chat":&#123;"id": NÚMERO&#125;</code></p>
          <p>4. Copiá ese número y pegalo arriba en <code className="bg-muted px-1 rounded">telegram_chat_id</code></p>
        </CardContent>
      </Card>
    </div>
  );
}
