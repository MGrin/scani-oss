package xyz.scani.mobile.shared.data

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DetailReadsTest {
    private val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
    private val db = ScaniDatabase(driver)

    @AfterTest
    fun tearDown() {
        driver.close()
    }

    @Test
    fun accountById_flow_and_snapshot() = runTest {
        val ctx = StandardTestDispatcher(testScheduler)
        db.accountQueries.insert("a1", "Savings", "bank", "inst1", "1000.00")
        db.accountQueries.insert("a2", "Cash", "cash", null, "50.00")

        val repo = AccountsRepository(db, ctx)
        val expected = MobileAccount("a1", "Savings", "bank", "inst1", "1000.00")

        assertEquals(expected, repo.accountById("a1").first())
        assertEquals(expected, repo.accountByIdSnapshot("a1"))
        assertNull(repo.accountByIdSnapshot("nope"))
    }

    @Test
    fun holdingById_flow_and_snapshot() = runTest {
        val ctx = StandardTestDispatcher(testScheduler)
        db.holdingQueries.insert("h1", "a1", "BTC", "Bitcoin", "0.5", "30000")
        db.holdingQueries.insert("h2", "a2", "ETH", "Ethereum", "2", null)

        val repo = HoldingsRepository(db, ctx)
        val expected = MobileHolding("h1", "a1", "BTC", "Bitcoin", "0.5", "30000")

        assertEquals(expected, repo.holdingById("h1").first())
        assertEquals(expected, repo.holdingByIdSnapshot("h1"))
        assertNull(repo.holdingByIdSnapshot("nope"))
    }

    @Test
    fun holdingsByAccount_flow_and_snapshot() = runTest {
        val ctx = StandardTestDispatcher(testScheduler)
        db.holdingQueries.insert("h1", "a1", "BTC", "Bitcoin", "0.5", "30000")
        db.holdingQueries.insert("h2", "a2", "ETH", "Ethereum", "2", null)

        val repo = HoldingsRepository(db, ctx)
        val h1 = MobileHolding("h1", "a1", "BTC", "Bitcoin", "0.5", "30000")

        assertEquals(listOf(h1), repo.holdingsByAccount("a1").first())
        assertEquals(listOf(h1), repo.holdingsByAccountSnapshot("a1"))
    }

    @Test
    fun groupById_flow_and_snapshot() = runTest {
        val ctx = StandardTestDispatcher(testScheduler)
        db.groupQueries.insert("g1", "Savings", "#FF0000", "My savings")

        val repo = GroupsRepository(db, ctx)
        val expected = MobileGroup("g1", "Savings", "#FF0000", "My savings")

        assertEquals(expected, repo.groupById("g1").first())
        assertEquals(expected, repo.groupByIdSnapshot("g1"))
        assertNull(repo.groupByIdSnapshot("nope"))
    }

    @Test
    fun vaultById_flow_and_snapshot() = runTest {
        val ctx = StandardTestDispatcher(testScheduler)
        db.vaultQueries.insert("v1", "Emergency Fund", "10000.00", "5000.00", "USD", "#0000FF", "shield", "Rainy day fund")

        val repo = VaultsRepository(db, ctx)
        val expected = MobileVault("v1", "Emergency Fund", "10000.00", "5000.00", "USD", "#0000FF", "shield", "Rainy day fund")

        assertEquals(expected, repo.vaultById("v1").first())
        assertEquals(expected, repo.vaultByIdSnapshot("v1"))
        assertNull(repo.vaultByIdSnapshot("nope"))
    }
}
