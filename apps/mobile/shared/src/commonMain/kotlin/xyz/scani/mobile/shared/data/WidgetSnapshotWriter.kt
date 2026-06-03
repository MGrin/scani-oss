package xyz.scani.mobile.shared.data

import kotlinx.serialization.json.Json

class WidgetSnapshotWriter(
    private val accounts: AccountsRepository,
    private val holdings: HoldingsRepository,
    private val groups: GroupsRepository,
    private val vaults: VaultsRepository,
    private val storage: WidgetStorage,
    private val now: () -> Long = { kotlin.time.Clock.System.now().toEpochMilliseconds() },
) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun refresh() {
        val a = accounts.snapshot()
        val h = holdings.snapshot()
        val g = groups.snapshot()
        val v = vaults.snapshot()
        // Widget total is an approximate glance — Double sum avoids a bigdecimal dep.
        val total = a.sumOf { it.totalValue.toDoubleOrNull() ?: 0.0 }
        val data = WidgetData(
            portfolioTotal = formatTotal(total),
            accounts = a.map { WidgetEntity(it.id, it.name, it.totalValue) },
            holdings = h.map { WidgetEntity(it.id, it.symbol, it.value ?: "—") },
            groups = g.map { WidgetEntity(it.id, it.name, it.description ?: "") },
            vaults = v.map { WidgetEntity(it.id, it.name, "${it.currentAmount} / ${it.targetAmount}") },
            updatedAt = now(),
        )
        storage.write(json.encodeToString(data))
    }

    private fun formatTotal(d: Double): String =
        if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
}
