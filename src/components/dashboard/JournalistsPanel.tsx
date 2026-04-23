import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2 } from "lucide-react";

export function JournalistsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", media_outlet: "", topics: "", search_keywords: "" });

  const { data: journalists, isLoading } = useQuery({
    queryKey: ["journalists"],
    queryFn: async () => {
      const { data, error } = await supabase.from("journalists").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });

  const addJournalist = useMutation({
    mutationFn: async () => {
      const topics = form.topics.split(",").map(t => t.trim()).filter(Boolean);
      const search_keywords = form.search_keywords.split(",").map(t => t.trim()).filter(Boolean);
      const payload = { name: form.name, media_outlet: form.media_outlet || null, topics, search_keywords, is_active: true };
      const { error } = await supabase.from("journalists").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Periodista agregado" });
      setForm({ name: "", media_outlet: "", topics: "", search_keywords: "" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["journalists"] });
    },
    onError: (e) => toast({ title: "Error", description: (e as Error).message, variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("journalists").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journalists"] }),
  });

  const deleteJournalist = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("journalists").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Periodista eliminado" });
      qc.invalidateQueries({ queryKey: ["journalists"] });
    },
  });

  if (isLoading) return <p className="text-muted-foreground">Cargando periodistas...</p>;

  const activeCount = (journalists || []).filter((j: any) => j.is_active).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Periodistas y analistas seguidos</h2>
          <Badge variant="secondary">{activeCount}/{journalists?.length || 0} activos</Badge>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />Agregar periodista</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Agregar periodista</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label htmlFor="jname">Nombre</Label>
                <Input id="jname" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="ej. Horacio Verbitsky" />
              </div>
              <div>
                <Label htmlFor="outlet">Medio (opcional)</Label>
                <Input id="outlet" value={form.media_outlet} onChange={e => setForm(f => ({ ...f, media_outlet: e.target.value }))} placeholder="ej. El Cohete a la Luna" />
              </div>
              <div>
                <Label htmlFor="topics">Temas (separados por coma)</Label>
                <Input id="topics" value={form.topics} onChange={e => setForm(f => ({ ...f, topics: e.target.value }))} placeholder="política, DDHH, investigación" />
              </div>
              <div>
                <Label htmlFor="kw">Keywords de búsqueda (separadas por coma)</Label>
                <Input id="kw" value={form.search_keywords} onChange={e => setForm(f => ({ ...f, search_keywords: e.target.value }))} placeholder="Verbitsky" />
                <p className="text-xs text-muted-foreground mt-1">El sistema marca los artículos que mencionan cualquiera de estas palabras.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={() => addJournalist.mutate()} disabled={!form.name || addJournalist.isPending}>Agregar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {(journalists || []).map((j: any) => (
          <Card key={j.id} className={j.is_active ? "" : "opacity-60"}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{j.name}</p>
                  {j.media_outlet && <p className="text-sm text-muted-foreground">{j.media_outlet}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Switch checked={j.is_active} onCheckedChange={(v) => toggleActive.mutate({ id: j.id, is_active: v })} />
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => {
                    if (confirm(`¿Eliminar "${j.name}"?`)) deleteJournalist.mutate(j.id);
                  }}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {(j.topics || []).map((t: string) => (
                  <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
                ))}
              </div>
              {(j.search_keywords || []).length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  <span className="font-medium">Keywords:</span> {(j.search_keywords || []).join(", ")}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
