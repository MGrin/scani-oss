package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OutboxProcessorTest {
    private val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
    private val db = ScaniDatabase(driver)

    @AfterTest
    fun tearDown() {
        driver.close()
    }

    private fun makeComponents(scheduler: TestCoroutineScheduler): Pair<WriteQueue, OutboxRepository> {
        val dispatcher = StandardTestDispatcher(scheduler)
        val outbox = OutboxRepository(db, dispatcher)
        var counter = 0
        val queue = WriteQueue(
            db = db,
            outbox = outbox,
            genId = { "id${++counter}" },
            now = { 1000L },
        )
        return queue to outbox
    }

    @Test
    fun drain_success_createGroup_reconciles_server_id() = runTest {
        val (queue, outbox) = makeComponents(testScheduler)

        val clientId = queue.createGroup("Tech", "#112233", null)

        val engine = MockEngine { request ->
            val path = request.url.encodedPath.removePrefix("/trpc/")
            when {
                path == "mobile.createGroup" -> respond(
                    content = """{"result":{"data":{"id":"server-g","name":"Tech","color":"#112233","description":null}}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
                path == "mobile.groups" -> respond(
                    content = """{"result":{"data":[{"id":"server-g","name":"Tech","color":"#112233","description":null}]}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
                else -> error("Unexpected path: $path")
            }
        }

        val client = mockTrpcClient(engine)
        val api = MobileApi(client)
        val syncEngine = SyncEngine(api, db)
        val processor = OutboxProcessor(client, outbox, syncEngine)

        processor.drain()

        assertEquals(0L, outbox.count())

        val groups = db.groupQueries.selectAll().executeAsList()
        assertEquals(1, groups.size)
        assertEquals("server-g", groups[0].id)
        assertEquals("Tech", groups[0].name)
        // optimistic client id is gone after reconcile
        assertNull(groups.firstOrNull { it.id == clientId })
    }

    @Test
    fun drain_transient_failure_halts_and_preserves_second_op() = runTest {
        val (queue, outbox) = makeComponents(testScheduler)

        queue.createGroup("First", "#111111", null)
        queue.createGroup("Second", "#222222", null)

        var requestCount = 0
        val engine = MockEngine { _ ->
            requestCount++
            // respond with a non-envelope 500 so body<TrpcEnvelope<T>>() throws a
            // deserialization error (generic Throwable, not TrpcException) — transient
            respond(
                content = "Internal Server Error",
                status = HttpStatusCode.InternalServerError,
                headers = headersOf(HttpHeaders.ContentType, "text/plain"),
            )
        }

        val client = mockTrpcClient(engine)
        val api = MobileApi(client)
        val syncEngine = SyncEngine(api, db)
        val processor = OutboxProcessor(client, outbox, syncEngine)

        processor.drain()

        // first op has attempts == 1
        val pending = outbox.pending()
        assertEquals(2, pending.size)
        assertEquals(1L, pending[0].attempts)
        assertNotNull(pending[0].lastError)

        // second op was NOT attempted — drain broke after first failure
        assertEquals(0L, pending[1].attempts)
        assertEquals(1, requestCount)
    }

    @Test
    fun drain_server_rejection_marks_dead_and_continues_second_op() = runTest {
        val (queue, outbox) = makeComponents(testScheduler)

        queue.createGroup("First", "#111111", null)
        queue.createGroup("Second", "#222222", null)

        var requestCount = 0
        val engine = MockEngine { request ->
            val path = request.url.encodedPath.removePrefix("/trpc/")
            requestCount++
            when (requestCount) {
                1 -> respond(
                    // proper tRPC error envelope → TrpcException → dead, continue
                    content = """{"error":{"message":"validation failed"}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
                else -> when {
                    path == "mobile.createGroup" -> respond(
                        content = """{"result":{"data":{"id":"server-g2","name":"Second","color":"#222222","description":null}}}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                    path == "mobile.groups" -> respond(
                        content = """{"result":{"data":[{"id":"server-g2","name":"Second","color":"#222222","description":null}]}}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                    else -> error("Unexpected path: $path")
                }
            }
        }

        val client = mockTrpcClient(engine)
        val api = MobileApi(client)
        val syncEngine = SyncEngine(api, db)
        val processor = OutboxProcessor(client, outbox, syncEngine)

        processor.drain()

        // first op is dead: recorded failure but still in outbox
        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals(1L, pending[0].attempts)
        assertNotNull(pending[0].lastError)
        assertTrue(pending[0].lastError!!.contains("validation failed"))

        // second op succeeded → removed from outbox
        assertEquals(1L, outbox.count())

        // drain attempted both ops (at least 2 requests for create + reconcile-sync GET)
        assertTrue(requestCount >= 2)
    }
}
