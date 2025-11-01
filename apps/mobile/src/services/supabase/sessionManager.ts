import { AppState } from "react-native"
import type { AppStateStatus } from "react-native"

import { supabase } from "./supabase"

export function setupSessionManager() {
  AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "active") {
      supabase.auth.startAutoRefresh()
    } else {
      supabase.auth.stopAutoRefresh()
    }
  })
}


