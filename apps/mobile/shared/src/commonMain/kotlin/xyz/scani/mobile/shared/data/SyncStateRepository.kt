package xyz.scani.mobile.shared.data

import kotlinx.coroutines.withContext
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class SyncStateRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    suspend fun lastSyncedAt(key: String): Long? = withContext(ioContext) {
        db.syncStateQueries.selectByKey(key).executeAsOneOrNull()
    }
}
