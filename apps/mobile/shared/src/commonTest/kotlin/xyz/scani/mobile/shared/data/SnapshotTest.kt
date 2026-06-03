package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SnapshotTest {
    private val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
    private val db = ScaniDatabase(driver)

    @AfterTest
    fun tearDown() {
        driver.close()
    }

    private fun engineFor(vararg pairs: Pair<String, String>) = MockEngine { request ->
        val path = request.url.encodedPath.removePrefix("/trpc/")
        val body = pairs.toMap()[path] ?: error("Unexpected path: $path")
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    @Test
    fun accounts_snapshot_empty_before_sync() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val repo = AccountsRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.snapshot())
    }

    @Test
    fun accounts_snapshot_populated_after_sync_with_null_institutionId() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "mobile.accounts" to """{"result":{"data":[
                {"id":"a1","name":"Savings","typeId":"bank","institutionId":"inst1","totalValue":"1000.00"},
                {"id":"a2","name":"Cash","typeId":"cash","totalValue":"50.00"}
            ]}}""",
            "mobile.holdings" to """{"result":{"data":[]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db)
        val repo = AccountsRepository(db, testDispatcher)

        syncEngine.syncAccounts()

        val accounts = repo.snapshot()
        assertEquals(2, accounts.size)
        assertEquals(MobileAccount("a1", "Savings", "bank", "inst1", "1000.00"), accounts[0])
        assertEquals(MobileAccount("a2", "Cash", "cash", null, "50.00"), accounts[1])
        assertNull(accounts[1].institutionId)
    }

    @Test
    fun accounts_snapshot_reflects_full_refresh() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val firstEngine = engineFor(
            "mobile.accounts" to """{"result":{"data":[
                {"id":"a1","name":"Old","typeId":"bank","totalValue":"100.00"}
            ]}}""",
            "mobile.holdings" to """{"result":{"data":[]}}""",
        )
        val api = MobileApi(mockTrpcClient(firstEngine))
        SyncEngine(api, db).syncAccounts()

        assertEquals(1, AccountsRepository(db, testDispatcher).snapshot().size)

        val secondEngine = engineFor(
            "mobile.accounts" to """{"result":{"data":[
                {"id":"b1","name":"New1","typeId":"cash","totalValue":"200.00"},
                {"id":"b2","name":"New2","typeId":"cash","totalValue":"300.00"}
            ]}}""",
            "mobile.holdings" to """{"result":{"data":[]}}""",
        )
        val api2 = MobileApi(mockTrpcClient(secondEngine))
        SyncEngine(api2, db).syncAccounts()

        val accounts = AccountsRepository(db, testDispatcher).snapshot()
        assertEquals(2, accounts.size)
        assertEquals("b1", accounts[0].id)
        assertEquals("b2", accounts[1].id)
    }

    @Test
    fun holdings_snapshot_empty_before_sync() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val repo = HoldingsRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.snapshot())
    }

    @Test
    fun holdings_snapshot_populated_after_sync_with_null_value() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "mobile.accounts" to """{"result":{"data":[]}}""",
            "mobile.holdings" to """{"result":{"data":[
                {"id":"h1","accountId":"a1","symbol":"BTC","name":"Bitcoin","amount":"0.5","value":"30000.00"},
                {"id":"h2","accountId":"a1","symbol":"ETH","name":"Ethereum","amount":"2.0"}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db)
        val repo = HoldingsRepository(db, testDispatcher)

        syncEngine.syncHoldings()

        val holdings = repo.snapshot()
        assertEquals(2, holdings.size)
        assertEquals(MobileHolding("h1", "a1", "BTC", "Bitcoin", "0.5", "30000.00"), holdings[0])
        assertEquals(MobileHolding("h2", "a1", "ETH", "Ethereum", "2.0", null), holdings[1])
        assertNull(holdings[1].value)
    }
}
