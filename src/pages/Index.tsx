import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourcesPanel } from "@/components/dashboard/SourcesPanel";
import { JournalistsPanel } from "@/components/dashboard/JournalistsPanel";
import { DigestsPanel } from "@/components/dashboard/DigestsPanel";
import { ConfigPanel } from "@/components/dashboard/ConfigPanel";
import { SchedulesPanel } from "@/components/dashboard/SchedulesPanel";
import { Newspaper, Users, Send, Settings, Clock } from "lucide-react";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Newspaper className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">Resumen Militante</h1>
            <p className="text-sm text-muted-foreground">Panel de control — Digest de noticias diario</p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <Tabs defaultValue="digests" className="space-y-4">
          <TabsList className="grid grid-cols-5 w-full max-w-2xl">
            <TabsTrigger value="digests" className="flex items-center gap-1.5 text-xs">
              <Send className="h-3.5 w-3.5" /> Envíos
            </TabsTrigger>
            <TabsTrigger value="sources" className="flex items-center gap-1.5 text-xs">
              <Newspaper className="h-3.5 w-3.5" /> Medios
            </TabsTrigger>
            <TabsTrigger value="journalists" className="flex items-center gap-1.5 text-xs">
              <Users className="h-3.5 w-3.5" /> Periodistas
            </TabsTrigger>
            <TabsTrigger value="schedules" className="flex items-center gap-1.5 text-xs">
              <Clock className="h-3.5 w-3.5" /> Horarios
            </TabsTrigger>
            <TabsTrigger value="config" className="flex items-center gap-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" /> Config
            </TabsTrigger>
          </TabsList>

          <TabsContent value="digests"><DigestsPanel /></TabsContent>
          <TabsContent value="sources"><SourcesPanel /></TabsContent>
          <TabsContent value="journalists"><JournalistsPanel /></TabsContent>
          <TabsContent value="schedules"><SchedulesPanel /></TabsContent>
          <TabsContent value="config"><ConfigPanel /></TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
