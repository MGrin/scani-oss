import { MMKV } from "react-native-mmkv"
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client"

const storage = new MMKV({
  id: "trpc-cache",
})

export const mmkvPersister: Persister = {
  persistClient: async (client: PersistedClient) => {
    storage.set("queryCache", JSON.stringify(client))
  },
  restoreClient: async () => {
    const cached = storage.getString("queryCache")
    return cached ? JSON.parse(cached) : undefined
  },
  removeClient: async () => {
    storage.delete("queryCache")
  },
}


