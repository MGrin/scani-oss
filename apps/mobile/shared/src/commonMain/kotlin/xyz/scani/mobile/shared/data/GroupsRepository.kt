package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import xyz.scani.mobile.shared.db.GroupEntity
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class GroupsRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    fun groups(): Flow<List<MobileGroup>> =
        db.groupQueries.selectAll().asFlow().mapToList(ioContext).map { rows -> rows.map(::toDto) }

    suspend fun snapshot(): List<MobileGroup> = withContext(ioContext) {
        db.groupQueries.selectAll().executeAsList().map(::toDto)
    }

    fun groupById(id: String): Flow<MobileGroup?> =
        db.groupQueries.selectById(id).asFlow().mapToOneOrNull(ioContext).map { it?.let(::toDto) }

    suspend fun groupByIdSnapshot(id: String): MobileGroup? = withContext(ioContext) {
        db.groupQueries.selectById(id).executeAsOneOrNull()?.let(::toDto)
    }

    private fun toDto(row: GroupEntity) = MobileGroup(row.id, row.name, row.color, row.description)
}
