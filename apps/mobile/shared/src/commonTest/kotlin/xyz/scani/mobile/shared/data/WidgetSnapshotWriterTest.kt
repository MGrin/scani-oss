package xyz.scani.mobile.shared.data

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class WidgetSnapshotWriterTest {
    private val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
    private val db = ScaniDatabase(driver)

    @AfterTest
    fun tearDown() {
        driver.close()
    }

    @Test
    fun refresh_builds_correct_widget_data() = runTest {
        val ctx = StandardTestDispatcher(testScheduler)

        db.accountQueries.insert("a1", "Checking", "bank", null, "100.5")
        db.accountQueries.insert("a2", "Savings", "bank", null, "200")
        db.holdingQueries.insert("h1", "a1", "BTC", "Bitcoin", "0.5", "90000")
        db.groupQueries.insert("g1", "Tech", "#FF0000", "stuff")
        db.vaultQueries.insert("v1", "Car", "1000", "250", "USD", "#0000FF", null, null)

        val accountsRepo = AccountsRepository(db, ctx)
        val holdingsRepo = HoldingsRepository(db, ctx)
        val groupsRepo = GroupsRepository(db, ctx)
        val vaultsRepo = VaultsRepository(db, ctx)

        var captured: String? = null
        val fakeStorage = object : WidgetStorage {
            override fun write(json: String) { captured = json }
        }

        val writer = WidgetSnapshotWriter(
            accountsRepo,
            holdingsRepo,
            groupsRepo,
            vaultsRepo,
            fakeStorage,
            now = { 1700000000000L },
        )
        writer.refresh()

        val data = Json.decodeFromString<WidgetData>(captured!!)
        assertEquals("300.5", data.portfolioTotal)
        assertEquals(listOf(WidgetEntity("a1", "Checking", "100.5"), WidgetEntity("a2", "Savings", "200")), data.accounts)
        assertEquals(WidgetEntity("h1", "BTC", "90000"), data.holdings[0])
        assertEquals(WidgetEntity("g1", "Tech", "stuff"), data.groups[0])
        assertEquals(WidgetEntity("v1", "Car", "250 / 1000"), data.vaults[0])
        assertEquals(1700000000000L, data.updatedAt)
    }
}
