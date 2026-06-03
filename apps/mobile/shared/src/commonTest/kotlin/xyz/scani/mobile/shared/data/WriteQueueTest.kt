package xyz.scani.mobile.shared.data

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import xyz.scani.mobile.shared.db.ScaniDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WriteQueueTest {
    private val driver = createTestDriver().also { ScaniDatabase.Schema.create(it) }
    private val db = ScaniDatabase(driver)

    @AfterTest
    fun tearDown() {
        driver.close()
    }

    private fun makeQueue(scheduler: TestCoroutineScheduler): Pair<WriteQueue, OutboxRepository> {
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
    fun createGroup_writes_cache_and_outbox() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        val clientId = queue.createGroup("Tech", "#112233", null)

        val groups = db.groupQueries.selectAll().executeAsList()
        assertEquals(1, groups.size)
        assertEquals(clientId, groups[0].id)
        assertEquals("Tech", groups[0].name)
        assertEquals("#112233", groups[0].color)
        assertNull(groups[0].description)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("group", pending[0].entity)
        assertEquals("create", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("Tech", json["name"]?.jsonPrimitive?.content)
        assertEquals("#112233", json["color"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun deleteGroup_removes_cache_row_and_enqueues_delete_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        val id = queue.createGroup("Tech", "#112233", null)
        val pendingBefore = outbox.pending()
        assertEquals(1, pendingBefore.size)

        queue.deleteGroup(id)

        val groups = db.groupQueries.selectAll().executeAsList()
        assertEquals(0, groups.size)

        val pending = outbox.pending()
        assertEquals(2, pending.size)
        val deleteOp = pending[1]
        assertEquals("group", deleteOp.entity)
        assertEquals("delete", deleteOp.op)
        val json = Json.parseToJsonElement(deleteOp.payload).jsonObject
        assertEquals(id, json["id"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun updateGroup_updates_cache_and_enqueues_update_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        db.groupQueries.insert("g-seed", "OldName", "#000000", null)

        queue.updateGroup("g-seed", name = "New")

        val groups = db.groupQueries.selectAll().executeAsList()
        assertEquals(1, groups.size)
        assertEquals("New", groups[0].name)
        assertEquals("#000000", groups[0].color)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("group", pending[0].entity)
        assertEquals("update", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("g-seed", json["id"]?.jsonPrimitive?.content)
        val data = json["data"]?.jsonObject
        assertNotNull(data)
        assertEquals("New", data["name"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun createHolding_writes_cache_with_display_fields_and_outbox_payload_has_backend_fields() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        val clientId = queue.createHolding(
            accountId = "a1",
            tokenId = "t1",
            symbol = "BTC",
            name = "Bitcoin",
            balance = "1.5",
        )

        val holdings = db.holdingQueries.selectAll().executeAsList()
        assertEquals(1, holdings.size)
        assertEquals(clientId, holdings[0].id)
        assertEquals("a1", holdings[0].accountId)
        assertEquals("BTC", holdings[0].symbol)
        assertEquals("Bitcoin", holdings[0].name)
        assertEquals("1.5", holdings[0].amount)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("holding", pending[0].entity)
        assertEquals("create", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertTrue(json["requestId"]?.jsonPrimitive?.content?.isNotEmpty() == true)
        assertEquals("a1", json["accountId"]?.jsonPrimitive?.content)
        assertNull(json["data"])
        assertNull(json["tokenId"])
        val newHoldings = json["newHoldings"]?.jsonArray
        assertNotNull(newHoldings)
        assertEquals(1, newHoldings.size)
        val first = newHoldings[0].jsonObject
        assertEquals("t1", first["tokenId"]?.jsonPrimitive?.content)
        assertEquals("1.5", first["balance"]?.jsonPrimitive?.content)
    }

    @Test
    fun createVault_writes_cache_and_outbox() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        val clientId = queue.createVault(
            name = "Emergency",
            targetAmount = "10000",
            currencyId = "USD",
            color = "#FF0000",
        )

        val vaults = db.vaultQueries.selectAll().executeAsList()
        assertEquals(1, vaults.size)
        assertEquals(clientId, vaults[0].id)
        assertEquals("Emergency", vaults[0].name)
        assertEquals("0", vaults[0].currentAmount)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("vault", pending[0].entity)
        assertEquals("create", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("Emergency", json["name"]?.jsonPrimitive?.content)
        assertEquals("10000", json["targetAmount"]?.jsonPrimitive?.content)
        assertEquals("USD", json["currencyId"]?.jsonPrimitive?.content)
        assertEquals("#FF0000", json["color"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun deleteVault_removes_cache_and_enqueues_delete_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        val id = queue.createVault("Emergency", "10000", "USD", "#FF0000")
        queue.deleteVault(id)

        assertEquals(0, db.vaultQueries.selectAll().executeAsList().size)

        val pending = outbox.pending()
        assertEquals(2, pending.size)
        assertEquals("vault", pending[1].entity)
        assertEquals("delete", pending[1].op)
        val json = Json.parseToJsonElement(pending[1].payload).jsonObject
        assertEquals(id, json["id"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun updateVault_updates_cache_and_enqueues_update_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        db.vaultQueries.insert("v-seed", "OldName", "5000", "1000", "USD", "#000000", null, null)

        queue.updateVault("v-seed", name = "NewName", targetAmount = "8000")

        val vaults = db.vaultQueries.selectAll().executeAsList()
        assertEquals("NewName", vaults[0].name)
        assertEquals("8000", vaults[0].targetAmount)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("vault", pending[0].entity)
        assertEquals("update", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("v-seed", json["id"]?.jsonPrimitive?.content)
        val data = json["data"]?.jsonObject
        assertNotNull(data)
        assertEquals("NewName", data["name"]?.jsonPrimitive?.content)
        assertEquals("8000", data["targetAmount"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun updateAccount_overlays_cache_and_enqueues_update_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        db.accountQueries.insert("acc1", "OldName", "bank", null, "5000")

        queue.updateAccount("acc1", name = "NewName")

        val accounts = db.accountQueries.selectAll().executeAsList()
        assertEquals("NewName", accounts[0].name)
        assertEquals("bank", accounts[0].typeId)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("account", pending[0].entity)
        assertEquals("update", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("acc1", json["id"]?.jsonPrimitive?.content)
        val data = json["data"]?.jsonObject
        assertNotNull(data)
        assertEquals("NewName", data["name"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun deleteAccount_removes_cache_and_enqueues_delete_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        db.accountQueries.insert("acc1", "Test", "bank", null, "5000")
        queue.deleteAccount("acc1")

        assertEquals(0, db.accountQueries.selectAll().executeAsList().size)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("account", pending[0].entity)
        assertEquals("delete", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("acc1", json["id"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun deleteHolding_removes_cache_and_enqueues_delete_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        db.holdingQueries.insert("h1", "a1", "BTC", "Bitcoin", "1.0", null)
        queue.deleteHolding("h1")

        assertEquals(0, db.holdingQueries.selectAll().executeAsList().size)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("holding", pending[0].entity)
        assertEquals("delete", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("h1", json["id"]?.jsonPrimitive?.content)
        assertNull(json["idempotencyKey"])
    }

    @Test
    fun updateHolding_overlays_cache_and_enqueues_update_op() = runTest {
        val (queue, outbox) = makeQueue(testScheduler)

        db.holdingQueries.insert("h1", "a1", "BTC", "Bitcoin", "1.0", null)

        queue.updateHolding("h1", balance = "2.5")

        val holdings = db.holdingQueries.selectAll().executeAsList()
        assertEquals("2.5", holdings[0].amount)
        assertEquals("BTC", holdings[0].symbol)

        val pending = outbox.pending()
        assertEquals(1, pending.size)
        assertEquals("holding", pending[0].entity)
        assertEquals("update", pending[0].op)
        val json = Json.parseToJsonElement(pending[0].payload).jsonObject
        assertEquals("h1", json["id"]?.jsonPrimitive?.content)
        val data = json["data"]?.jsonObject
        assertNotNull(data)
        assertEquals("2.5", data["balance"]?.jsonPrimitive?.content)
        assertTrue(json["idempotencyKey"]?.jsonPrimitive?.content?.isNotEmpty() == true)
    }
}
