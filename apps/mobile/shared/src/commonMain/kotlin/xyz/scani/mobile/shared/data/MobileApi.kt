package xyz.scani.mobile.shared.data

import xyz.scani.mobile.shared.network.TrpcClient

class MobileApi(private val client: TrpcClient) {
    suspend fun accounts(): List<MobileAccount> = client.query("mobile.accounts")
    suspend fun holdings(): List<MobileHolding> = client.query("mobile.holdings")
    suspend fun groups(): List<MobileGroup> = client.query("mobile.groups")
    suspend fun vaults(): List<MobileVault> = client.query("mobile.vaults")
}
