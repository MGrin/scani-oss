import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client"
import { MMKV } from "react-native-mmkv"

export const trpcCacheStorage = new MMKV({
  id: "trpc-cache",
})

export const mmkvPersister: Persister = {
  persistClient: async (client: PersistedClient) => {
    trpcCacheStorage.set("queryCache", JSON.stringify(client))
  },
  restoreClient: async () => {
    const cached = trpcCacheStorage.getString("queryCache")
    return cached ? JSON.parse(cached) : undefined
  },
  removeClient: async () => {
    trpcCacheStorage.delete("queryCache")
  },
}
