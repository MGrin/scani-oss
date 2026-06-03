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

@Serializable
data class MobileGroup(
    val id: String,
    val name: String,
    val color: String,
    val description: String? = null,
)

@Serializable
data class MobileVault(
    val id: String,
    val name: String,
    val targetAmount: String,
    val currentAmount: String,
    val currencyId: String,
    val color: String,
    val iconName: String? = null,
    val description: String? = null,
)

@Serializable
data class MobileToken(val id: String, val symbol: String, val name: String)
