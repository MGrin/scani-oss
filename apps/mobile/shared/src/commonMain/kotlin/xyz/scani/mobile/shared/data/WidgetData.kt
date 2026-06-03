package xyz.scani.mobile.shared.data

import kotlinx.serialization.Serializable

@Serializable data class WidgetEntity(val id: String, val name: String, val value: String)

@Serializable
data class WidgetData(
    val portfolioTotal: String,
    val accounts: List<WidgetEntity>,
    val holdings: List<WidgetEntity>,
    val groups: List<WidgetEntity>,
    val vaults: List<WidgetEntity>,
    val updatedAt: Long,
)
