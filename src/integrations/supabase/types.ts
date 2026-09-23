export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      admin_activity_logs: {
        Row: {
          action: string;
          activity_date: string;
          activity_time: string;
          actor_email: string | null;
          actor_id: string | null;
          changed_fields: string[];
          created_at: string;
          id: string;
          ip_address: string | null;
          record_id: string | null;
          resource_type: string;
          summary: string;
          target_label: string;
        };
        Insert: {
          action: string;
          activity_date?: string;
          activity_time?: string;
          actor_email?: string | null;
          actor_id?: string | null;
          changed_fields?: string[];
          created_at?: string;
          id?: string;
          ip_address?: string | null;
          record_id?: string | null;
          resource_type: string;
          summary: string;
          target_label: string;
        };
        Update: {
          action?: string;
          activity_date?: string;
          activity_time?: string;
          actor_email?: string | null;
          actor_id?: string | null;
          changed_fields?: string[];
          created_at?: string;
          id?: string;
          ip_address?: string | null;
          record_id?: string | null;
          resource_type?: string;
          summary?: string;
          target_label?: string;
        };
        Relationships: [];
      };
      appointment_services: {
        Row: {
          appointment_id: string;
          duration_minutes: number;
          id: string;
          price: number;
          service_id: string | null;
          service_name: string;
        };
        Insert: {
          appointment_id: string;
          duration_minutes?: number;
          id?: string;
          price?: number;
          service_id?: string | null;
          service_name: string;
        };
        Update: {
          appointment_id?: string;
          duration_minutes?: number;
          id?: string;
          price?: number;
          service_id?: string | null;
          service_name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_services_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_services_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
        ];
      };
      appointment_continuations: {
        Row: {
          appointment_date: string;
          appointment_id: string;
          assigned_crew_id: string;
          booking_duration_minutes: number;
          created_at: string;
          id: string;
          segment_number: number;
          start_time: string;
        };
        Insert: {
          appointment_date: string;
          appointment_id: string;
          assigned_crew_id: string;
          booking_duration_minutes: number;
          created_at?: string;
          id?: string;
          segment_number: number;
          start_time: string;
        };
        Update: {
          appointment_date?: string;
          appointment_id?: string;
          assigned_crew_id?: string;
          booking_duration_minutes?: number;
          created_at?: string;
          id?: string;
          segment_number?: number;
          start_time?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_continuations_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_continuations_assigned_crew_id_fkey";
            columns: ["assigned_crew_id"];
            isOneToOne: false;
            referencedRelation: "crew_members";
            referencedColumns: ["id"];
          },
        ];
      };
      appointments: {
        Row: {
          admin_notes: string | null;
          appointment_date: string;
          assigned_crew_id: string | null;
          booking_request_id: string | null;
          cancelled_at: string | null;
          archived_at: string | null;
          created_at: string;
          booking_duration_minutes: number;
          customer_name: string;
          first_name: string | null;
          id: string;
          is_archived: boolean;
          last_reschedule_rejected_at: string | null;
          last_reschedule_rejection_message: string | null;
          last_name: string | null;
          middle_name: string | null;
          moto_brand: string;
          moto_model: string;
          moto_variant: string | null;
          moto_year: number | null;
          notes: string | null;
          phone: string;
          plate_number: string;
          pending_reschedule_date: string | null;
          pending_reschedule_reference_code: string | null;
          pending_reschedule_reason: string | null;
          pending_reschedule_request_id: string | null;
          pending_reschedule_start_time: string | null;
          reference_code: string;
          reschedule_count: number;
          rescheduled_from_appointment_id: string | null;
          rescheduled_to_appointment_id: string | null;
          start_time: string;
          status: string;
          terms_accepted: boolean;
          total_estimate: number;
          updated_at: string;
        };
        Insert: {
          admin_notes?: string | null;
          appointment_date: string;
          assigned_crew_id?: string | null;
          booking_request_id?: string | null;
          cancelled_at?: string | null;
          archived_at?: string | null;
          created_at?: string;
          booking_duration_minutes?: number;
          customer_name: string;
          first_name?: string | null;
          id?: string;
          is_archived?: boolean;
          last_reschedule_rejected_at?: string | null;
          last_reschedule_rejection_message?: string | null;
          last_name?: string | null;
          middle_name?: string | null;
          moto_brand: string;
          moto_model: string;
          moto_variant?: string | null;
          moto_year?: number | null;
          notes?: string | null;
          phone: string;
          plate_number: string;
          pending_reschedule_date?: string | null;
          pending_reschedule_reference_code?: string | null;
          pending_reschedule_reason?: string | null;
          pending_reschedule_request_id?: string | null;
          pending_reschedule_start_time?: string | null;
          reference_code: string;
          reschedule_count?: number;
          rescheduled_from_appointment_id?: string | null;
          rescheduled_to_appointment_id?: string | null;
          start_time: string;
          status?: string;
          terms_accepted?: boolean;
          total_estimate?: number;
          updated_at?: string;
        };
        Update: {
          admin_notes?: string | null;
          appointment_date?: string;
          assigned_crew_id?: string | null;
          booking_request_id?: string | null;
          cancelled_at?: string | null;
          archived_at?: string | null;
          created_at?: string;
          booking_duration_minutes?: number;
          customer_name?: string;
          first_name?: string | null;
          id?: string;
          is_archived?: boolean;
          last_reschedule_rejected_at?: string | null;
          last_reschedule_rejection_message?: string | null;
          last_name?: string | null;
          middle_name?: string | null;
          moto_brand?: string;
          moto_model?: string;
          moto_variant?: string | null;
          moto_year?: number | null;
          notes?: string | null;
          phone?: string;
          plate_number?: string;
          pending_reschedule_date?: string | null;
          pending_reschedule_reference_code?: string | null;
          pending_reschedule_reason?: string | null;
          pending_reschedule_request_id?: string | null;
          pending_reschedule_start_time?: string | null;
          reference_code?: string;
          reschedule_count?: number;
          rescheduled_from_appointment_id?: string | null;
          rescheduled_to_appointment_id?: string | null;
          start_time?: string;
          status?: string;
          terms_accepted?: boolean;
          total_estimate?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointments_assigned_crew_id_fkey";
            columns: ["assigned_crew_id"];
            isOneToOne: false;
            referencedRelation: "crew_members";
            referencedColumns: ["id"];
          },
        ];
      };
      appointment_reschedule_history: {
        Row: {
          id: string;
          appointment_id: string;
          new_appointment_id: string | null;
          reschedule_number: number;
          from_date: string;
          from_start_time: string;
          to_date: string | null;
          to_start_time: string | null;
          reason: string;
          decision: string;
          approved_at: string;
          approved_by: string | null;
        };
        Insert: {
          id?: string;
          appointment_id: string;
          new_appointment_id?: string | null;
          reschedule_number: number;
          from_date: string;
          from_start_time: string;
          to_date?: string | null;
          to_start_time?: string | null;
          reason: string;
          decision: string;
          approved_at?: string;
          approved_by?: string | null;
        };
        Update: {
          id?: string;
          appointment_id?: string;
          new_appointment_id?: string | null;
          reschedule_number?: number;
          from_date?: string;
          from_start_time?: string;
          to_date?: string | null;
          to_start_time?: string | null;
          reason?: string;
          decision?: string;
          approved_at?: string;
          approved_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_reschedule_history_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_reschedule_history_new_appointment_id_fkey";
            columns: ["new_appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
        ];
      };
      blocked_numbers: {
        Row: {
          archived_at: string | null;
          id: string;
          phone: string;
          reason: string | null;
          created_at: string;
          created_by: string | null;
          is_archived: boolean;
        };
        Insert: {
          archived_at?: string | null;
          id?: string;
          phone: string;
          reason?: string | null;
          created_at?: string;
          created_by?: string | null;
          is_archived?: boolean;
        };
        Update: {
          archived_at?: string | null;
          id?: string;
          phone?: string;
          reason?: string | null;
          created_at?: string;
          created_by?: string | null;
          is_archived?: boolean;
        };
        Relationships: [];
      };
      crew_availability_exceptions: {
        Row: {
          created_at: string;
          crew_id: string;
          end_date: string;
          end_time: string | null;
          id: string;
          is_all_day: boolean;
          note: string | null;
          reason: string;
          start_date: string;
          start_time: string | null;
        };
        Insert: {
          created_at?: string;
          crew_id: string;
          end_date: string;
          end_time?: string | null;
          id?: string;
          is_all_day?: boolean;
          note?: string | null;
          reason: string;
          start_date: string;
          start_time?: string | null;
        };
        Update: {
          created_at?: string;
          crew_id?: string;
          end_date?: string;
          end_time?: string | null;
          id?: string;
          is_all_day?: boolean;
          note?: string | null;
          reason?: string;
          start_date?: string;
          start_time?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "crew_availability_exceptions_crew_id_fkey";
            columns: ["crew_id"];
            isOneToOne: false;
            referencedRelation: "crew_members";
            referencedColumns: ["id"];
          },
        ];
      };
      crew_members: {
        Row: {
          archived_at: string | null;
          created_at: string;
          id: string;
          is_active: boolean;
          is_archived: boolean;
          name: string;
          phone: string | null;
          role: string;
        };
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_archived?: boolean;
          name: string;
          phone?: string | null;
          role?: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_archived?: boolean;
          name?: string;
          phone?: string | null;
          role?: string;
        };
        Relationships: [];
      };
      crew_schedules: {
        Row: {
          created_at: string;
          crew_id: string;
          day_of_week: number;
          effective_from: string | null;
          effective_to: string | null;
          end_time: string | null;
          id: string;
          is_working: boolean;
          note: string | null;
          schedule_date: string | null;
          start_time: string | null;
        };
        Insert: {
          created_at?: string;
          crew_id: string;
          day_of_week: number;
          effective_from?: string | null;
          effective_to?: string | null;
          end_time?: string | null;
          id?: string;
          is_working?: boolean;
          note?: string | null;
          schedule_date?: string | null;
          start_time?: string | null;
        };
        Update: {
          created_at?: string;
          crew_id?: string;
          day_of_week?: number;
          effective_from?: string | null;
          effective_to?: string | null;
          end_time?: string | null;
          id?: string;
          is_working?: boolean;
          note?: string | null;
          schedule_date?: string | null;
          start_time?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "crew_schedules_crew_id_fkey";
            columns: ["crew_id"];
            isOneToOne: false;
            referencedRelation: "crew_members";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          appointment_id: string | null;
          created_at: string;
          id: string;
          is_read: boolean;
          message: string | null;
          title: string;
          type: string;
        };
        Insert: {
          appointment_id?: string | null;
          created_at?: string;
          id?: string;
          is_read?: boolean;
          message?: string | null;
          title: string;
          type?: string;
        };
        Update: {
          appointment_id?: string | null;
          created_at?: string;
          id?: string;
          is_read?: boolean;
          message?: string | null;
          title?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
        ];
      };
      price_history: {
        Row: {
          changed_by: string | null;
          changed_by_email: string | null;
          configuration_id: string | null;
          configuration_label: string | null;
          created_at: string;
          id: string;
          item_id: string;
          item_name: string;
          new_price: number;
          old_price: number;
          reason: string | null;
          table_name: string;
        };
        Insert: {
          changed_by?: string | null;
          changed_by_email?: string | null;
          configuration_id?: string | null;
          configuration_label?: string | null;
          created_at?: string;
          id?: string;
          item_id: string;
          item_name: string;
          new_price: number;
          old_price: number;
          reason?: string | null;
          table_name: string;
        };
        Update: {
          changed_by?: string | null;
          changed_by_email?: string | null;
          configuration_id?: string | null;
          configuration_label?: string | null;
          created_at?: string;
          id?: string;
          item_id?: string;
          item_name?: string;
          new_price?: number;
          old_price?: number;
          reason?: string | null;
          table_name?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          archived_at: string | null;
          brand: string | null;
          category: string;
          created_at: string;
          description: string | null;
          id: string;
          image_url: string | null;
          in_stock: boolean;
          is_active: boolean;
          is_archived: boolean;
          is_featured: boolean;
          name: string;
          price: number;
          sort_order: number;
          stock_quantity: number;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          brand?: string | null;
          category?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          image_url?: string | null;
          in_stock?: boolean;
          is_active?: boolean;
          is_archived?: boolean;
          is_featured?: boolean;
          name: string;
          price?: number;
          sort_order?: number;
          stock_quantity?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          brand?: string | null;
          category?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          image_url?: string | null;
          in_stock?: boolean;
          is_active?: boolean;
          is_archived?: boolean;
          is_featured?: boolean;
          name?: string;
          price?: number;
          sort_order?: number;
          stock_quantity?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      motorcycle_catalog: {
        Row: {
          archived_at: string | null;
          brand: string | null;
          created_at: string;
          id: string;
          is_active: boolean;
          is_archived: boolean;
          model: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          brand?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_archived?: boolean;
          model: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          brand?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_archived?: boolean;
          model?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      schedule_blocks: {
        Row: {
          archived_at: string | null;
          block_date: string;
          created_at: string;
          id: string;
          is_active: boolean;
          reason: string | null;
          start_time: string | null;
        };
        Insert: {
          archived_at?: string | null;
          block_date: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          reason?: string | null;
          start_time?: string | null;
        };
        Update: {
          archived_at?: string | null;
          block_date?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          reason?: string | null;
          start_time?: string | null;
        };
        Relationships: [];
      };
      shop_settings: {
        Row: {
          address: string;
          allow_same_day_appointments: boolean;
          booking_terms: string;
          cancellation_notice_hours: number;
          contact_email: string;
          contact_number: string;
          default_appointment_duration_minutes: number;
          id: boolean;
          logo_url: string | null;
          max_advance_booking_days: number;
          minimum_booking_lead_hours: number;
          opening_time: string;
          closing_time: string;
          notify_admin: boolean;
          notify_cancellation: boolean;
          notify_confirmation: boolean;
          notify_reminder: boolean;
          reminder_hours_before: number;
          rescheduling_notice_hours: number;
          shop_name: string;
          updated_at: string;
        };
        Insert: {
          address?: string;
          allow_same_day_appointments?: boolean;
          booking_terms?: string;
          cancellation_notice_hours?: number;
          contact_email?: string;
          contact_number?: string;
          default_appointment_duration_minutes?: number;
          id?: boolean;
          logo_url?: string | null;
          max_advance_booking_days?: number;
          minimum_booking_lead_hours?: number;
          opening_time?: string;
          closing_time?: string;
          notify_admin?: boolean;
          notify_cancellation?: boolean;
          notify_confirmation?: boolean;
          notify_reminder?: boolean;
          reminder_hours_before?: number;
          rescheduling_notice_hours?: number;
          shop_name?: string;
          updated_at?: string;
        };
        Update: {
          address?: string;
          allow_same_day_appointments?: boolean;
          booking_terms?: string;
          cancellation_notice_hours?: number;
          contact_email?: string;
          contact_number?: string;
          default_appointment_duration_minutes?: number;
          id?: boolean;
          logo_url?: string | null;
          max_advance_booking_days?: number;
          minimum_booking_lead_hours?: number;
          opening_time?: string;
          closing_time?: string;
          notify_admin?: boolean;
          notify_cancellation?: boolean;
          notify_confirmation?: boolean;
          notify_reminder?: boolean;
          reminder_hours_before?: number;
          rescheduling_notice_hours?: number;
          shop_name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      service_model_overrides: {
        Row: {
          brand: string;
          created_at: string;
          duration_minutes: number;
          id: string;
          model: string;
          price: number;
          service_id: string;
          updated_at: string;
        };
        Insert: {
          brand: string;
          created_at?: string;
          duration_minutes: number;
          id?: string;
          model: string;
          price: number;
          service_id: string;
          updated_at?: string;
        };
        Update: {
          brand?: string;
          created_at?: string;
          duration_minutes?: number;
          id?: string;
          model?: string;
          price?: number;
          service_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "service_model_overrides_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
        ];
      };
      services: {
        Row: {
          archived_at: string | null;
          category: string;
          created_at: string;
          description: string | null;
          duration_minutes: number;
          id: string;
          image_url: string | null;
          is_active: boolean;
          is_archived: boolean;
          name: string;
          price: number;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          category?: string;
          created_at?: string;
          description?: string | null;
          duration_minutes?: number;
          id?: string;
          image_url?: string | null;
          is_active?: boolean;
          is_archived?: boolean;
          name: string;
          price?: number;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          category?: string;
          created_at?: string;
          description?: string | null;
          duration_minutes?: number;
          id?: string;
          image_url?: string | null;
          is_active?: boolean;
          is_archived?: boolean;
          name?: string;
          price?: number;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      time_slots: {
        Row: {
          capacity: number;
          created_at: string;
          end_time: string;
          id: string;
          is_active: boolean;
          start_time: string;
        };
        Insert: {
          capacity?: number;
          created_at?: string;
          end_time: string;
          id?: string;
          is_active?: boolean;
          start_time: string;
        };
        Update: {
          capacity?: number;
          created_at?: string;
          end_time?: string;
          id?: string;
          is_active?: boolean;
          start_time?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      cancel_public_appointment: {
        Args: {
          p_appointment_id: string;
          p_cancellation_notice_hours: number;
        };
        Returns: undefined;
      };
      create_booking_atomic: {
        Args: {
          p_appointment_date: string;
          p_assigned_crew_id: string | null;
          p_booking_duration_minutes: number;
          p_booking_request_id: string;
          p_continuation_segments: Json;
          p_customer_name: string;
          p_first_name: string;
          p_last_name: string;
          p_middle_name: string;
          p_moto_brand: string;
          p_moto_model: string;
          p_moto_variant: string | null;
          p_moto_year: number;
          p_notification_message: string;
          p_notification_title: string;
          p_notes: string | null;
          p_phone: string;
          p_plate_number: string;
          p_reference_code: string;
          p_services: Json;
          p_start_time: string;
          p_total_estimate: number;
        };
        Returns: {
          appointment_id: string;
          reference_code: string;
        }[];
      };
      review_pending_appointment: {
        Args: {
          p_appointment_id: string;
          p_decision: string;
        };
        Returns: undefined;
      };
      review_reschedule_request: {
        Args: {
          p_appointment_id: string;
          p_decision: string;
        };
        Returns: undefined;
      };
      submit_reschedule_request: {
        Args: {
          p_appointment_date: string;
          p_appointment_id: string;
          p_reason: string;
          p_request_id: string;
          p_start_time: string;
        };
        Returns: undefined;
      };
      update_appointment_details_atomic: {
        Args: {
          p_admin_notes: string | null;
          p_appointment_date: string;
          p_appointment_id: string;
          p_assigned_crew_id: string | null;
          p_crew_assignment_manual: boolean;
          p_first_name: string;
          p_last_name: string;
          p_middle_name: string;
          p_phone: string;
          p_service_ids: string[];
          p_start_time: string;
          p_status: string;
        };
        Returns: undefined;
      };
      enforce_public_rate_limit: {
        Args: {
          p_limit: number;
          p_scope: string;
          p_subject: string;
          p_window_seconds: number;
        };
        Returns: boolean;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      get_admin_customers_page: {
        Args: {
          p_limit?: number;
          p_offset?: number;
          p_search?: string | null;
        };
        Returns: Json;
      };
      get_admin_report_page: {
        Args: {
          p_category?: string | null;
          p_from: string;
          p_limit?: number;
          p_offset?: number;
          p_report_kind: string;
          p_service_name?: string | null;
          p_status?: string | null;
          p_to: string;
        };
        Returns: Json;
      };
      purge_expired_admin_activity_logs: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      record_admin_activity_event: {
        Args: {
          p_action: string;
          p_changed_fields?: string[];
          p_resource_type: string;
          p_summary: string;
          p_target_label: string;
        };
        Returns: string;
      };
    };
    Enums: {
      app_role: "admin";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["admin"],
    },
  },
} as const;
