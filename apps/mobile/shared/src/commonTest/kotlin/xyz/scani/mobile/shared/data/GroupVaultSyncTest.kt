package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import xyz.scani.mobile.shared.network.TrpcClient
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GroupVaultSyncTest {
    private val fixedNow = 1_700_000_000_000L
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
    fun groups_empty_before_sync_then_populated_after() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "mobile.groups" to """{"result":{"data":[
                {"id":"g1","name":"Savings","color":"#FF0000","description":"My savings"},
                {"id":"g2","name":"Investments","color":"#00FF00"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(engine, "https://api.test"))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })
        val repo = GroupsRepository(db, testDispatcher)
        val syncStateRepo = SyncStateRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.groups().first())

        syncEngine.syncGroups()

        val groups = repo.groups().first()
        assertEquals(2, groups.size)
        assertEquals(MobileGroup("g1", "Savings", "#FF0000", "My savings"), groups[0])
        assertEquals(MobileGroup("g2", "Investments", "#00FF00", null), groups[1])
        assertNull(groups[1].description)
        assertEquals(fixedNow, syncStateRepo.lastSyncedAt("groups"))
    }

    @Test
    fun syncGroups_second_call_fully_replaces_data() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val firstEngine = engineFor(
            "mobile.groups" to """{"result":{"data":[
                {"id":"g1","name":"Old","color":"#FF0000"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(firstEngine, "https://api.test"))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })
        val repo = GroupsRepository(db, testDispatcher)

        syncEngine.syncGroups()
        assertEquals(1, repo.groups().first().size)

        val secondEngine = engineFor(
            "mobile.groups" to """{"result":{"data":[
                {"id":"g2","name":"New1","color":"#00FF00"},
                {"id":"g3","name":"New2","color":"#0000FF"}
            ]}}""",
        )
        val api2 = MobileApi(TrpcClient(secondEngine, "https://api.test"))
        SyncEngine(api2, db, now = { fixedNow }).syncGroups()

        val groups = repo.groups().first()
        assertEquals(2, groups.size)
        assertEquals("g2", groups[0].id)
        assertEquals("g3", groups[1].id)
    }

    @Test
    fun groups_snapshot_empty_before_sync_then_populated_after() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "mobile.groups" to """{"result":{"data":[
                {"id":"g1","name":"Savings","color":"#FF0000","description":"My savings"},
                {"id":"g2","name":"Investments","color":"#00FF00"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(engine, "https://api.test"))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })
        val repo = GroupsRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.snapshot())

        syncEngine.syncGroups()

        val groups = repo.snapshot()
        assertEquals(2, groups.size)
        assertEquals(MobileGroup("g1", "Savings", "#FF0000", "My savings"), groups[0])
        assertNull(groups[1].description)
    }

    @Test
    fun vaults_empty_before_sync_then_populated_after() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "mobile.vaults" to """{"result":{"data":[
                {"id":"v1","name":"Emergency Fund","targetAmount":"10000.00","currentAmount":"5000.00","currencyId":"USD","color":"#0000FF","iconName":"shield","description":"Rainy day fund"},
                {"id":"v2","name":"Vacation","targetAmount":"3000.00","currentAmount":"1200.00","currencyId":"EUR","color":"#FFFF00"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(engine, "https://api.test"))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })
        val repo = VaultsRepository(db, testDispatcher)
        val syncStateRepo = SyncStateRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.vaults().first())

        syncEngine.syncVaults()

        val vaults = repo.vaults().first()
        assertEquals(2, vaults.size)
        assertEquals(MobileVault("v1", "Emergency Fund", "10000.00", "5000.00", "USD", "#0000FF", "shield", "Rainy day fund"), vaults[0])
        assertEquals(MobileVault("v2", "Vacation", "3000.00", "1200.00", "EUR", "#FFFF00", null, null), vaults[1])
        assertNull(vaults[1].iconName)
        assertNull(vaults[1].description)
        assertEquals(fixedNow, syncStateRepo.lastSyncedAt("vaults"))
    }

    @Test
    fun syncVaults_second_call_fully_replaces_data() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val firstEngine = engineFor(
            "mobile.vaults" to """{"result":{"data":[
                {"id":"v1","name":"Old","targetAmount":"100.00","currentAmount":"50.00","currencyId":"USD","color":"#FF0000"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(firstEngine, "https://api.test"))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })
        val repo = VaultsRepository(db, testDispatcher)

        syncEngine.syncVaults()
        assertEquals(1, repo.vaults().first().size)

        val secondEngine = engineFor(
            "mobile.vaults" to """{"result":{"data":[
                {"id":"v2","name":"New1","targetAmount":"200.00","currentAmount":"100.00","currencyId":"EUR","color":"#00FF00"},
                {"id":"v3","name":"New2","targetAmount":"300.00","currentAmount":"200.00","currencyId":"GBP","color":"#0000FF"}
            ]}}""",
        )
        val api2 = MobileApi(TrpcClient(secondEngine, "https://api.test"))
        SyncEngine(api2, db, now = { fixedNow }).syncVaults()

        val vaults = repo.vaults().first()
        assertEquals(2, vaults.size)
        assertEquals("v2", vaults[0].id)
        assertEquals("v3", vaults[1].id)
    }

    @Test
    fun vaults_snapshot_empty_before_sync_then_populated_after() = runTest {
        val testDispatcher = StandardTestDispatcher(testScheduler)
        val engine = engineFor(
            "mobile.vaults" to """{"result":{"data":[
                {"id":"v1","name":"Emergency Fund","targetAmount":"10000.00","currentAmount":"5000.00","currencyId":"USD","color":"#0000FF","iconName":"shield","description":"Rainy day fund"},
                {"id":"v2","name":"Vacation","targetAmount":"3000.00","currentAmount":"1200.00","currencyId":"EUR","color":"#FFFF00"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(engine, "https://api.test"))
        val syncEngine = SyncEngine(api, db, now = { fixedNow })
        val repo = VaultsRepository(db, testDispatcher)

        assertEquals(emptyList(), repo.snapshot())

        syncEngine.syncVaults()

        val vaults = repo.snapshot()
        assertEquals(2, vaults.size)
        assertEquals(MobileVault("v1", "Emergency Fund", "10000.00", "5000.00", "USD", "#0000FF", "shield", "Rainy day fund"), vaults[0])
        assertNull(vaults[1].iconName)
        assertNull(vaults[1].description)
    }
}
