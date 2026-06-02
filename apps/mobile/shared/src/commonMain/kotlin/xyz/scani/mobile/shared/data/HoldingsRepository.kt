package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import xyz.scani.mobile.shared.db.Holding
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class HoldingsRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    fun holdings(): Flow<List<MobileHolding>> =
        db.holdingQueries.selectAll().asFlow().mapToList(ioContext).map { rows -> rows.map(::toDto) }

    suspend fun snapshot(): List<MobileHolding> = withContext(ioContext) {
        db.holdingQueries.selectAll().executeAsList().map(::toDto)
    }

    private fun toDto(row: Holding): MobileHolding =
        MobileHolding(row.id, row.accountId, row.symbol, row.name, row.amount, row.value_)
}
