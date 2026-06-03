package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
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

    fun holdingById(id: String): Flow<MobileHolding?> =
        db.holdingQueries.selectById(id).asFlow().mapToOneOrNull(ioContext).map { it?.let(::toDto) }

    suspend fun holdingByIdSnapshot(id: String): MobileHolding? = withContext(ioContext) {
        db.holdingQueries.selectById(id).executeAsOneOrNull()?.let(::toDto)
    }

    fun holdingsByAccount(accountId: String): Flow<List<MobileHolding>> =
        db.holdingQueries.selectByAccount(accountId).asFlow().mapToList(ioContext).map { it.map(::toDto) }

    suspend fun holdingsByAccountSnapshot(accountId: String): List<MobileHolding> = withContext(ioContext) {
        db.holdingQueries.selectByAccount(accountId).executeAsList().map(::toDto)
    }

    private fun toDto(row: Holding): MobileHolding =
        MobileHolding(row.id, row.accountId, row.symbol, row.name, row.amount, row.value_)
}
