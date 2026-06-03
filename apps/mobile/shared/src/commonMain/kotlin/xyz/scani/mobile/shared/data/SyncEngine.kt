package xyz.scani.mobile.shared.data

import xyz.scani.mobile.shared.db.ScaniDatabase

class SyncEngine(
    private val api: MobileApi,
    private val db: ScaniDatabase,
    private val now: () -> Long = { kotlin.time.Clock.System.now().toEpochMilliseconds() },
) {
    suspend fun syncAccounts() {
        val rows = api.accounts()
        db.accountQueries.transaction {
            db.accountQueries.deleteAll()
            rows.forEach { db.accountQueries.insert(it.id, it.name, it.typeId, it.institutionId, it.totalValue) }
            db.syncStateQueries.upsert("accounts", now())
        }
    }

    suspend fun syncHoldings() {
        val rows = api.holdings()
        db.holdingQueries.transaction {
            db.holdingQueries.deleteAll()
            rows.forEach { db.holdingQueries.insert(it.id, it.accountId, it.symbol, it.name, it.amount, it.value) }
            db.syncStateQueries.upsert("holdings", now())
        }
    }

    suspend fun syncGroups() {
        val rows = api.groups()
        db.groupQueries.transaction {
            db.groupQueries.deleteAll()
            rows.forEach { db.groupQueries.insert(it.id, it.name, it.color, it.description) }
            db.syncStateQueries.upsert("groups", now())
        }
    }

    suspend fun syncVaults() {
        val rows = api.vaults()
        db.vaultQueries.transaction {
            db.vaultQueries.deleteAll()
            rows.forEach { db.vaultQueries.insert(it.id, it.name, it.targetAmount, it.currentAmount, it.currencyId, it.color, it.iconName, it.description) }
            db.syncStateQueries.upsert("vaults", now())
        }
    }
}
