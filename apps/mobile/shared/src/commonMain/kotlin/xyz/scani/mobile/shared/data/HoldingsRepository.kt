package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class HoldingsRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    fun holdings(): Flow<List<MobileHolding>> =
        db.holdingQueries.selectAll().asFlow().mapToList(ioContext).map { rows ->
            rows.map { MobileHolding(it.id, it.accountId, it.symbol, it.name, it.amount, it.value_) }
        }
}
