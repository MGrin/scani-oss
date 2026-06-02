package xyz.scani.mobile.shared.data

import xyz.scani.mobile.shared.db.ScaniDatabase

class SyncEngine(private val api: MobileApi, private val db: ScaniDatabase) {
    suspend fun syncAccounts() {
        val rows = api.accounts()
        db.accountQueries.transaction {
            db.accountQueries.deleteAll()
            rows.forEach { db.accountQueries.insert(it.id, it.name, it.typeId, it.institutionId, it.totalValue) }
        }
    }

    suspend fun syncHoldings() {
        val rows = api.holdings()
        db.holdingQueries.transaction {
            db.holdingQueries.deleteAll()
            rows.forEach { db.holdingQueries.insert(it.id, it.accountId, it.symbol, it.name, it.amount, it.value) }
        }
    }
}
