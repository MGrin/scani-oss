package xyz.scani.mobile.shared.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import xyz.scani.trpc.TrpcClient
import xyz.scani.trpc.TrpcException

class OutboxProcessor(
    private val client: TrpcClient,
    private val outbox: OutboxRepository,
    private val syncEngine: SyncEngine,
) {
    suspend fun drain() {
        val createdEntities = mutableSetOf<String>()
        for (item in outbox.pending()) {
            val payload = Json.parseToJsonElement(item.payload)
            try {
                client.mutate<JsonElement>(procedureFor(item.entity, item.op), payload)
                outbox.markDone(item.id)
                if (item.op == "create") createdEntities += item.entity
            } catch (e: TrpcException) {
                // server rejected the mutation (well-formed tRPC error envelope) → dead, continue draining
                outbox.recordFailure(item.id, e.message ?: "rejected")
            } catch (e: Throwable) {
                // transient failure (network, timeout, non-envelope response) → preserve FIFO, retry next trigger
                outbox.recordFailure(item.id, e.message ?: "transient")
                break
            }
        }
        if (createdEntities.isNotEmpty()) reconcile(createdEntities)
    }

    private suspend fun reconcile(entities: Set<String>) {
        if ("account" in entities) syncEngine.syncAccounts()
        if ("holding" in entities) syncEngine.syncHoldings()
        if ("group" in entities) syncEngine.syncGroups()
        if ("vault" in entities) syncEngine.syncVaults()
    }

    private fun procedureFor(entity: String, op: String): String =
        "mobile.$op${entity.replaceFirstChar { it.uppercase() }}"
}
