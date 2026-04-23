import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2 } from "lucide-react";

const categoryLabels: Record<string, string> = {
  nacional: "🇦🇷 Nacional",
  afin: "✊ Afín/Alternativo",
  revista: "📖 Revista",
  analisis_politico: "🔍 Análisis Político",
  local: "📍 Local GBA/PBA",
  internacional_latam: "🌎 Latam",
  internacional_global: "🌍 Global",
  internacional_oriental: "🌏 Oriental",
  sectorial: "⚡ Sectorial",
  centro_de_estudio: "🎓 Centro de Estudio",
};

const categoryOptions = Object.keys(categoryLabels);

export function SourcesPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", category: "nacional", language: "es" });

  const { data: sources, isLoading } = useQuery({
    queryKey: ["media_sources"],
    queryFn: async () => {
      const { data, error } = await supabase.from("media_sources").select("*").order("category").order("name");
      if (error) throw error;
      return data;
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("media_sources").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["media_sources"] }),
    onError: (e) => toast({ title: "Error", description: (e as Error).message, variant: "destructive" }),
  });

  const addSource = useMutation({
    mutationFn: async () => {
      const payload = { ...form, is_active: true, category: form.category as any };
      const { error } = await supabase.from("media_sources").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Medio agregado" });
      setForm({ name: "", url: "", category: "nacional", language: "es" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["media_sources"] });
    },
    onError: (e) => toast({ title: "Error", description: (e as Error).message, variant: "destructive" }),
  });

  const deleteSource = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("media_sources").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Medio eliminado" });
      qc.invalidateQueries({ queryKey: ["media_sources"] });
    },
    onError: (e) => toast({ title: "Error", description: (e as Error).message, variant: "destructive" }),
  });

  if (isLoading) return <p className="text-muted-foreground">Cargando medios...</p>;

  const grouped = (sources || []).reduce((acc: Record<string, any[]>, s) => {
    if (!acc[s.category]) acc[s.category] = [];
    acc[s.category].push(s);
    return acc;
  }, {});

  const activeCount = (sources || []).filter((s: any) => s.is_active).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Medios monitoreados</h2>
          <Badge variant="secondary">{activeCount}/{sources?.length || 0} activos</Badge>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />Agregar medio</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Agregar nuevo medio</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label htmlFor="name">Nombre</Label>
                <Input id="name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="ej. El Destape" />
              </div>
              <div>
                <Label htmlFor="url">URL del medio</Label>
                <Input id="url" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://..." />
              </div>
              <div>
                <Label htmlFor="category">Categoría</Label>
                <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map(c => (
                      <SelectItem key={c} value={c}>{categoryLabels[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="lang">Idioma</Label>
                <Select value={form.language} onValueChange={v => setForm(f => ({ ...f, language: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Español</SelectItem>
                    <SelectItem value="en">Inglés</SelectItem>
                    <SelectItem value="pt">Portugués</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={() => addSource.mutate()} disabled={!form.name || !form.url || addSource.isPending}>Agregar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(grouped).map(([category, items]) => (
          <Card key={category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {categoryLabels[category] || category} <span className="text-muted-foreground font-normal">({items.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {items.map((s: any) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className={`hover:underline truncate block ${s.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                        {s.name}
                      </a>
                      <span className="text-xs text-muted-foreground uppercase">{s.language}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={s.is_active} onCheckedChange={(v) => toggleActive.mutate({ id: s.id, is_active: v })} />
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => {
                        if (confirm(`¿Eliminar "${s.name}"?`)) deleteSource.mutate(s.id);
                      }}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
