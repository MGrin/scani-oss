package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
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

    private fun toDto(row: Account): MobileAccount =
        MobileAccount(row.id, row.name, row.typeId, row.institutionId, row.totalValue)
}
