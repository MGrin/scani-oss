@file:OptIn(kotlin.uuid.ExperimentalUuidApi::class)

package xyz.scani.mobile.shared.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import xyz.scani.mobile.shared.db.ScaniDatabase

class WriteQueue(
    private val db: ScaniDatabase,
    private val outbox: OutboxRepository,
    private val genId: () -> String = { kotlin.uuid.Uuid.random().toString() },
    private val now: () -> Long = { kotlin.time.Clock.System.now().toEpochMilliseconds() },
) {
    suspend fun createGroup(name: String, color: String, description: String?): String {
        val id = genId()
        val key = genId()
        db.groupQueries.insert(id, name, color, description)
        val payload = buildJsonObject {
            put("name", name)
            put("color", color)
            if (description != null) put("description", description)
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "group", "create", payload.toString(), key, now())
        return id
    }

    suspend fun updateGroup(id: String, name: String? = null, color: String? = null, description: String? = null) {
        val row = db.groupQueries.selectAll().executeAsList().firstOrNull { it.id == id } ?: return
        db.groupQueries.insert(id, name ?: row.name, color ?: row.color, description ?: row.description)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            putJsonObject("data") {
                if (name != null) put("name", name)
                if (color != null) put("color", color)
                if (description != null) put("description", description)
            }
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "group", "update", payload.toString(), key, now())
    }

    suspend fun deleteGroup(id: String) {
        db.groupQueries.deleteById(id)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "group", "delete", payload.toString(), key, now())
    }

    suspend fun createVault(
        name: String,
        targetAmount: String,
        currencyId: String,
        color: String,
        iconName: String? = null,
        description: String? = null,
    ): String {
        val id = genId()
        val key = genId()
        db.vaultQueries.insert(id, name, targetAmount, "0", currencyId, color, iconName, description)
        val payload = buildJsonObject {
            put("name", name)
            put("targetAmount", targetAmount)
            put("currencyId", currencyId)
            put("color", color)
            if (iconName != null) put("iconName", iconName)
            if (description != null) put("description", description)
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "vault", "create", payload.toString(), key, now())
        return id
    }

    suspend fun updateVault(
        id: String,
        name: String? = null,
        targetAmount: String? = null,
        currencyId: String? = null,
        color: String? = null,
        iconName: String? = null,
        description: String? = null,
    ) {
        val row = db.vaultQueries.selectAll().executeAsList().firstOrNull { it.id == id } ?: return
        db.vaultQueries.insert(
            id,
            name ?: row.name,
            targetAmount ?: row.targetAmount,
            row.currentAmount,
            currencyId ?: row.currencyId,
            color ?: row.color,
            iconName ?: row.iconName,
            description ?: row.description,
        )
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            putJsonObject("data") {
                if (name != null) put("name", name)
                if (targetAmount != null) put("targetAmount", targetAmount)
                if (currencyId != null) put("currencyId", currencyId)
                if (color != null) put("color", color)
                if (iconName != null) put("iconName", iconName)
                if (description != null) put("description", description)
            }
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "vault", "update", payload.toString(), key, now())
    }

    suspend fun deleteVault(id: String) {
        db.vaultQueries.deleteById(id)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "vault", "delete", payload.toString(), key, now())
    }

    suspend fun updateAccount(id: String, name: String? = null) {
        val row = db.accountQueries.selectAll().executeAsList().firstOrNull { it.id == id } ?: return
        db.accountQueries.insert(id, name ?: row.name, row.typeId, row.institutionId, row.totalValue)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            putJsonObject("data") {
                if (name != null) put("name", name)
            }
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "account", "update", payload.toString(), key, now())
    }

    suspend fun deleteAccount(id: String) {
        db.accountQueries.deleteById(id)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "account", "delete", payload.toString(), key, now())
    }

    suspend fun createHolding(
        accountId: String,
        tokenId: String,
        symbol: String,
        name: String,
        balance: String,
    ): String {
        val id = genId()
        val key = genId()
        db.holdingQueries.insert(id, accountId, symbol, name, balance, null)
        val payload = buildJsonObject {
            putJsonObject("data") {
                put("accountId", accountId)
                put("tokenId", tokenId)
                put("balance", balance)
            }
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "holding", "create", payload.toString(), key, now())
        return id
    }

    suspend fun updateHolding(id: String, balance: String? = null) {
        val row = db.holdingQueries.selectAll().executeAsList().firstOrNull { it.id == id } ?: return
        db.holdingQueries.insert(id, row.accountId, row.symbol, row.name, balance ?: row.amount, row.value_)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            putJsonObject("data") {
                if (balance != null) put("balance", balance)
            }
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "holding", "update", payload.toString(), key, now())
    }

    suspend fun deleteHolding(id: String) {
        db.holdingQueries.deleteById(id)
        val key = genId()
        val payload = buildJsonObject {
            put("id", id)
            put("idempotencyKey", key)
        }
        outbox.enqueue(genId(), "holding", "delete", payload.toString(), key, now())
    }
}
