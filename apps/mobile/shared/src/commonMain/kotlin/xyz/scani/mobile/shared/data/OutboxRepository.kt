package xyz.scani.mobile.shared.data

import kotlinx.coroutines.withContext
import xyz.scani.mobile.shared.db.Outbox
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.coroutines.CoroutineContext

class OutboxRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    suspend fun enqueue(id: String, entity: String, op: String, payload: String, idempotencyKey: String, createdAt: Long) =
        withContext(ioContext) { db.outboxQueries.insert(id, entity, op, payload, idempotencyKey, createdAt) }

    suspend fun pending(): List<Outbox> =
        withContext(ioContext) { db.outboxQueries.selectPending().executeAsList() }

    suspend fun markDone(id: String) =
        withContext(ioContext) { db.outboxQueries.deleteById(id) }

    suspend fun recordFailure(id: String, error: String) =
        withContext(ioContext) { db.outboxQueries.recordFailure(error, id) }

    suspend fun count(): Long =
        withContext(ioContext) { db.outboxQueries.countAll().executeAsOne() }
}
