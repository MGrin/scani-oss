package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import xyz.scani.mobile.shared.db.Account
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class AccountsRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    fun accounts(): Flow<List<MobileAccount>> =
        db.accountQueries.selectAll().asFlow().mapToList(ioContext).map { rows -> rows.map(::toDto) }

    suspend fun snapshot(): List<MobileAccount> = withContext(ioContext) {
        db.accountQueries.selectAll().executeAsList().map(::toDto)
    }

    fun accountById(id: String): Flow<MobileAccount?> =
        db.accountQueries.selectById(id).asFlow().mapToOneOrNull(ioContext).map { it?.let(::toDto) }

    suspend fun accountByIdSnapshot(id: String): MobileAccount? = withContext(ioContext) {
        db.accountQueries.selectById(id).executeAsOneOrNull()?.let(::toDto)
    }

    private fun toDto(row: Account): MobileAccount =
        MobileAccount(row.id, row.name, row.typeId, row.institutionId, row.totalValue)
}
