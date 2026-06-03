package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import xyz.scani.mobile.shared.db.ScaniDatabase
import xyz.scani.mobile.shared.db.Vault
import kotlin.coroutines.CoroutineContext

class VaultsRepository(private val db: ScaniDatabase, private val ioContext: CoroutineContext) {
    fun vaults(): Flow<List<MobileVault>> =
        db.vaultQueries.selectAll().asFlow().mapToList(ioContext).map { rows -> rows.map(::toDto) }

    suspend fun snapshot(): List<MobileVault> = withContext(ioContext) {
        db.vaultQueries.selectAll().executeAsList().map(::toDto)
    }

    private fun toDto(row: Vault) = MobileVault(row.id, row.name, row.targetAmount, row.currentAmount, row.currencyId, row.color, row.iconName, row.description)
}
