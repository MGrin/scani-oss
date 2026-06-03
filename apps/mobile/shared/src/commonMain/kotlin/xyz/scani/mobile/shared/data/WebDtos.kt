package xyz.scani.mobile.shared.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class WebAccountSummary(val totalValue: String)

@Serializable
data class WebAccount(
    val id: String,
    val name: String,
    val typeId: String,
    val institutionId: String? = null,
    val summary: WebAccountSummary,
) {
    fun toApp() = MobileAccount(id, name, typeId, institutionId, summary.totalValue)
}

@Serializable
data class WebToken(val symbol: String, val name: String)

@Serializable
data class WebAccountRef(val id: String)

@Serializable
data class WebHolding(
    val id: String,
    val token: WebToken,
    val amount: JsonPrimitive,
    val value: JsonPrimitive? = null,
    val account: WebAccountRef,
) {
    fun toApp() = MobileHolding(
        id = id,
        accountId = account.id,
        symbol = token.symbol,
        name = token.name,
        amount = amount.content,
        value = value?.content,
    )
}
