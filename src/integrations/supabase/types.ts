export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      digest_config: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      digest_schedules: {
        Row: {
          created_at: string
          cron_expression: string
          description: string | null
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          created_at?: string
          cron_expression: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          created_at?: string
          cron_expression?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: []
      }
      digest_sends: {
        Row: {
          articles_count: number | null
          created_at: string
          digest_type: string | null
          error_message: string | null
          id: string
          learning_notes: string | null
          schedule_id: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["digest_status"]
          telegram_message: string | null
        }
        Insert: {
          articles_count?: number | null
          created_at?: string
          digest_type?: string | null
          error_message?: string | null
          id?: string
          learning_notes?: string | null
          schedule_id?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["digest_status"]
          telegram_message?: string | null
        }
        Update: {
          articles_count?: number | null
          created_at?: string
          digest_type?: string | null
          error_message?: string | null
          id?: string
          learning_notes?: string | null
          schedule_id?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["digest_status"]
          telegram_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "digest_sends_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "digest_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      journalists: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          media_outlet: string | null
          name: string
          search_keywords: string[] | null
          topics: string[] | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          media_outlet?: string | null
          name: string
          search_keywords?: string[] | null
          topics?: string[] | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          media_outlet?: string | null
          name?: string
          search_keywords?: string[] | null
          topics?: string[] | null
        }
        Relationships: []
      }
      media_sources: {
        Row: {
          category: Database["public"]["Enums"]["media_category"]
          created_at: string
          id: string
          is_active: boolean
          language: string
          name: string
          scrape_config: Json | null
          updated_at: string
          url: string
        }
        Insert: {
          category: Database["public"]["Enums"]["media_category"]
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          name: string
          scrape_config?: Json | null
          updated_at?: string
          url: string
        }
        Update: {
          category?: Database["public"]["Enums"]["media_category"]
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          name?: string
          scrape_config?: Json | null
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      scraped_articles: {
        Row: {
          author: string | null
          category: Database["public"]["Enums"]["article_category"] | null
          content_markdown: string | null
          created_at: string
          has_gender_angle: boolean | null
          id: string
          is_about_argentina: boolean | null
          is_about_grabois: boolean | null
          is_used_in_digest: boolean | null
          journalist_id: string | null
          language: string | null
          published_at: string | null
          scraped_at: string
          source_id: string | null
          summary: string | null
          title: string
          url: string
        }
        Insert: {
          author?: string | null
          category?: Database["public"]["Enums"]["article_category"] | null
          content_markdown?: string | null
          created_at?: string
          has_gender_angle?: boolean | null
          id?: string
          is_about_argentina?: boolean | null
          is_about_grabois?: boolean | null
          is_used_in_digest?: boolean | null
          journalist_id?: string | null
          language?: string | null
          published_at?: string | null
          scraped_at?: string
          source_id?: string | null
          summary?: string | null
          title: string
          url: string
        }
        Update: {
          author?: string | null
          category?: Database["public"]["Enums"]["article_category"] | null
          content_markdown?: string | null
          created_at?: string
          has_gender_angle?: boolean | null
          id?: string
          is_about_argentina?: boolean | null
          is_about_grabois?: boolean | null
          is_used_in_digest?: boolean | null
          journalist_id?: string | null
          language?: string | null
          published_at?: string | null
          scraped_at?: string
          source_id?: string | null
          summary?: string | null
          title?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "scraped_articles_journalist_id_fkey"
            columns: ["journalist_id"]
            isOneToOne: false
            referencedRelation: "journalists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scraped_articles_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "media_sources"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      article_category:
        | "politica"
        | "economia"
        | "social"
        | "internacional"
        | "opinion"
        | "analisis"
        | "local"
        | "energia"
        | "informe"
      digest_status: "pending" | "sent" | "failed"
      media_category:
        | "nacional"
        | "afin"
        | "revista"
        | "analisis_politico"
        | "local"
        | "internacional_latam"
        | "internacional_global"
        | "internacional_oriental"
        | "sectorial"
        | "centro_de_estudio"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      article_category: [
        "politica",
        "economia",
        "social",
        "internacional",
        "opinion",
        "analisis",
        "local",
        "energia",
        "informe",
      ],
      digest_status: ["pending", "sent", "failed"],
      media_category: [
        "nacional",
        "afin",
        "revista",
        "analisis_politico",
        "local",
        "internacional_latam",
        "internacional_global",
        "internacional_oriental",
        "sectorial",
        "centro_de_estudio",
      ],
    },
  },
} as const
