package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class SyncStateTest {
    private val fixedNow = 1_700_000_000_000L

    private fun engineFor(vararg pairs: Pair<String, String>) = MockEngine { request ->
        val path = request.url.encodedPath.removePrefix("/trpc/")
        val body = pairs.toMap()[path] ?: error("Unexpected path: $path")
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    private fun engineWithStatus(path: String, status: HttpStatusCode) = MockEngine { request ->
        val reqPath = request.url.encodedPath.removePrefix("/trpc/")
        if (reqPath == path) {
            respond(content = "", status = status, headers = headersOf())
        } else {
            error("Unexpected path: $reqPath")
        }
    }

    @Test
    fun lastSyncedAt_null_before_any_sync() = runTest {
        val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
        val db = ScaniDatabase(driver)
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val syncStateRepo = SyncStateRepository(db, testDispatcher)

        assertNull(syncStateRepo.lastSyncedAt("accounts"))
        assertNull(syncStateRepo.lastSyncedAt("holdings"))

        driver.close()
    }

    @Test
    fun syncAccounts_stamps_accounts_key() = runTest {
        val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
        val db = ScaniDatabase(driver)
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val syncStateRepo = SyncStateRepository(db, testDispatcher)

        val engine = engineFor(
            "mobile.accounts" to """{"result":{"data":[
                {"id":"a1","name":"Savings","typeId":"bank","totalValue":"1000.00"}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })

        assertNull(syncStateRepo.lastSyncedAt("accounts"))

        syncEngine.syncAccounts()

        assertEquals(fixedNow, syncStateRepo.lastSyncedAt("accounts"))
        assertNull(syncStateRepo.lastSyncedAt("holdings"))

        driver.close()
    }

    @Test
    fun syncHoldings_stamps_holdings_key() = runTest {
        val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
        val db = ScaniDatabase(driver)
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val syncStateRepo = SyncStateRepository(db, testDispatcher)

        val engine = engineFor(
            "mobile.holdings" to """{"result":{"data":[
                {"id":"h1","accountId":"a1","symbol":"BTC","name":"Bitcoin","amount":"0.5","value":"30000.00"}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })

        assertNull(syncStateRepo.lastSyncedAt("holdings"))

        syncEngine.syncHoldings()

        assertEquals(fixedNow, syncStateRepo.lastSyncedAt("holdings"))
        assertNull(syncStateRepo.lastSyncedAt("accounts"))

        driver.close()
    }

    @Test
    fun failing_sync_does_not_stamp_timestamp() = runTest {
        val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
        val db = ScaniDatabase(driver)
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val syncStateRepo = SyncStateRepository(db, testDispatcher)

        val engine = engineWithStatus("mobile.accounts", HttpStatusCode.InternalServerError)
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })

        assertFailsWith<Exception> {
            syncEngine.syncAccounts()
        }

        assertNull(syncStateRepo.lastSyncedAt("accounts"))

        driver.close()
    }
}
