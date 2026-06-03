package xyz.scani.mobile.shared.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.scani.mobile.shared.network.TrpcClient

class MobileApi(private val client: TrpcClient) {
    suspend fun accounts(): List<MobileAccount> = client.query("mobile.accounts")
    suspend fun holdings(): List<MobileHolding> = client.query("mobile.holdings")
    suspend fun groups(): List<MobileGroup> = client.query("mobile.groups")
    suspend fun vaults(): List<MobileVault> = client.query("mobile.vaults")
    suspend fun currencies(): List<MobileToken> = client.query("mobile.currencies")
    suspend fun searchTokens(query: String): List<MobileToken> =
        client.query("mobile.searchTokens", buildJsonObject { put("query", query) })
}
