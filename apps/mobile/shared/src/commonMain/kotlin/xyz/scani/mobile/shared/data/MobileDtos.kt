package xyz.scani.mobile.shared.data

import kotlinx.serialization.Serializable

@Serializable
data class MobileAccount(
    val id: String,
    val name: String,
    val typeId: String,
    val institutionId: String? = null,
    val totalValue: String,
)

@Serializable
data class MobileHolding(
    val id: String,
    val accountId: String,
    val symbol: String,
    val name: String,
    val amount: String,
    val value: String? = null,
)
