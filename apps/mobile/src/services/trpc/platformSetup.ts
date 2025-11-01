import { useEffect } from "react"
import { AppState, Platform } from "react-native"
import type { AppStateStatus } from "react-native"
import { onlineManager, focusManager } from "@tanstack/react-query"

export function setupOnlineManager() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Network = require("expo-network")
    onlineManager.setEventListener((setOnline) => {
      const subscription = Network.addNetworkStateListener((state: any) => {
        setOnline(!!state.isConnected)
      })
      return subscription.remove
    })
  } catch (error) {
    console.log("expo-network not available, skipping online manager setup")
    onlineManager.setOnline(true)
  }
}

export function useAppFocusManager() {
  useEffect(() => {
    const onAppStateChange = (status: AppStateStatus) => {
      if (Platform.OS !== "web") {
        focusManager.setFocused(status === "active")
      }
    }

    const subscription = AppState.addEventListener("change", onAppStateChange)
    return () => subscription.remove()
  }, [])
}

