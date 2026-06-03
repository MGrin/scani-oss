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

@Serializable
data class WebGroup(val id: String, val name: String, val color: String, val description: String? = null) {
    fun toApp() = MobileGroup(id, name, color, description)
}

@Serializable
data class WebVault(
    val id: String,
    val name: String,
    val targetAmount: String,
    val currentAmount: String,
    val currencyId: String,
    val color: String,
    val iconName: String? = null,
    val description: String? = null,
) {
    fun toApp() = MobileVault(id, name, targetAmount, currentAmount, currencyId, color, iconName, description)
}

@Serializable
data class WebTokenResult(
    val id: String? = null,
    val symbol: String,
    val name: String,
    val provider: String? = null,
    val metadata: kotlinx.serialization.json.JsonObject? = null,
) {
    fun toResult() = MobileTokenResult(id, symbol, name, provider, metadata)
}

@Serializable
data class UploadUrlResponse(
    val uploadUrl: String,
    val key: String,
    val headers: Map<String, String> = emptyMap(),
)
