package xyz.scani.mobile.shared.data

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class OutboxRepositoryTest {
    private val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
    private val db = ScaniDatabase(driver)

    @AfterTest
    fun tearDown() {
        driver.close()
    }

    @Test
    fun enqueue_two_ops_pending_returns_fifo_order() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val repo = OutboxRepository(db, dispatcher)

        repo.enqueue("id1", "account", "create", """{"x":1}""", "key1", 1000L)
        repo.enqueue("id2", "account", "update", """{"x":2}""", "key2", 2000L)

        val pending = repo.pending()
        assertEquals(2, pending.size)
        assertEquals("id1", pending[0].id)
        assertEquals("id2", pending[1].id)
    }

    @Test
    fun markDone_removes_entry() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val repo = OutboxRepository(db, dispatcher)

        repo.enqueue("id1", "account", "create", """{"x":1}""", "key1", 1000L)
        repo.enqueue("id2", "account", "update", """{"x":2}""", "key2", 2000L)

        repo.markDone("id1")

        val pending = repo.pending()
        assertEquals(1, pending.size)
        assertEquals("id2", pending[0].id)
        assertEquals(1L, repo.count())
    }

    @Test
    fun recordFailure_increments_attempts_and_sets_lastError() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val repo = OutboxRepository(db, dispatcher)

        repo.enqueue("id1", "account", "create", """{"x":1}""", "key1", 1000L)
        repo.recordFailure("id1", "boom")

        val pending = repo.pending()
        assertEquals(1, pending.size)
        assertEquals(1L, pending[0].attempts)
        assertEquals("boom", pending[0].lastError)
    }
}
