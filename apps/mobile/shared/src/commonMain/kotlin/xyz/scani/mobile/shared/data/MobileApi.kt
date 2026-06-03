package xyz.scani.mobile.shared.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.scani.trpc.TrpcClient

class MobileApi(private val client: TrpcClient) {
    suspend fun accounts(): List<MobileAccount> =
        client.query<List<WebAccount>>("accounts.getByUserIdWithSummary").map { it.toApp() }
    suspend fun holdings(): List<MobileHolding> =
        client.query<List<WebHolding>>("holdings.getWithDetails").map { it.toApp() }
    suspend fun groups(): List<MobileGroup> =
        client.query<List<WebGroup>>("groups.getAllWithCounts").map { it.toApp() }
    suspend fun vaults(): List<MobileVault> =
        client.query<List<WebVault>>("vaults.getAll").map { it.toApp() }
    suspend fun currencies(): List<MobileToken> =
        client.query("users.getSupportedCurrencies")
    suspend fun searchTokens(query: String): List<MobileTokenResult> =
        client.query<List<WebTokenResult>>("tokens.search", buildJsonObject { put("query", query) }).map { it.toResult() }
    suspend fun materializeToken(symbol: String, provider: String, metadata: JsonObject): MobileToken =
        client.mutate("tokens.createFromExternal", buildJsonObject {
            put("symbol", symbol)
            put("provider", provider)
            put("metadata", metadata)
        })
}
