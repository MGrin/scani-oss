package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class AccountsRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    fun accounts(): Flow<List<MobileAccount>> =
        db.accountQueries.selectAll().asFlow().mapToList(ioContext).map { rows ->
            rows.map { MobileAccount(it.id, it.name, it.typeId, it.institutionId, it.totalValue) }
        }
}
