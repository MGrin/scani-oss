package xyz.scani.mobile.shared.data

import app.cash.sqldelight.db.SqlDriver
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

expect fun createTestDriver(): SqlDriver

class SyncRepoTest {
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
    fun accounts_empty_before_sync_then_populated_after() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "accounts.getByUserIdWithSummary" to """{"result":{"data":[
                {"id":"a1","name":"Savings","typeId":"bank","institutionId":"inst1","summary":{"totalValue":"1000.00"}},
                {"id":"a2","name":"Cash","typeId":"cash","summary":{"totalValue":"50.00"}}
            ]}}""",
            "holdings.getWithDetails" to """{"result":{"data":[]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db)
        val repo = AccountsRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.accounts().first())

        syncEngine.syncAccounts()

        val accounts = repo.accounts().first()
        assertEquals(2, accounts.size)
        assertEquals(MobileAccount("a1", "Savings", "bank", "inst1", "1000.00"), accounts[0])
        assertEquals(MobileAccount("a2", "Cash", "cash", null, "50.00"), accounts[1])
    }

    @Test
    fun syncAccounts_second_call_fully_replaces_data() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val firstEngine = engineFor(
            "accounts.getByUserIdWithSummary" to """{"result":{"data":[
                {"id":"a1","name":"Old","typeId":"bank","summary":{"totalValue":"100.00"}}
            ]}}""",
            "holdings.getWithDetails" to """{"result":{"data":[]}}""",
        )
        val api = MobileApi(mockTrpcClient(firstEngine))
        val syncEngine = SyncEngine(api, db)
        val repo = AccountsRepository(db, testDispatcher)

        syncEngine.syncAccounts()
        assertEquals(1, repo.accounts().first().size)

        val secondEngine = engineFor(
            "accounts.getByUserIdWithSummary" to """{"result":{"data":[
                {"id":"b1","name":"New1","typeId":"cash","summary":{"totalValue":"200.00"}},
                {"id":"b2","name":"New2","typeId":"cash","summary":{"totalValue":"300.00"}}
            ]}}""",
            "holdings.getWithDetails" to """{"result":{"data":[]}}""",
        )
        val api2 = MobileApi(mockTrpcClient(secondEngine))
        val syncEngine2 = SyncEngine(api2, db)

        syncEngine2.syncAccounts()

        val accounts = repo.accounts().first()
        assertEquals(2, accounts.size)
        assertEquals("b1", accounts[0].id)
        assertEquals("b2", accounts[1].id)
    }

    @Test
    fun holdings_empty_before_sync_then_populated_after() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "accounts.getByUserIdWithSummary" to """{"result":{"data":[]}}""",
            "holdings.getWithDetails" to """{"result":{"data":[
                {"id":"h1","token":{"symbol":"BTC","name":"Bitcoin"},"amount":0.5,"value":30000,"account":{"id":"a1"}},
                {"id":"h2","token":{"symbol":"ETH","name":"Ethereum"},"amount":2,"account":{"id":"a1"}}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val syncEngine = SyncEngine(api, db)
        val repo = HoldingsRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.holdings().first())

        syncEngine.syncHoldings()

        val holdings = repo.holdings().first()
        assertEquals(2, holdings.size)
        assertEquals(MobileHolding("h1", "a1", "BTC", "Bitcoin", "0.5", "30000"), holdings[0])
        assertEquals(MobileHolding("h2", "a1", "ETH", "Ethereum", "2", null), holdings[1])
    }
}
