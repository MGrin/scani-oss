package xyz.scani.mobile.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
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

    fun vaultById(id: String): Flow<MobileVault?> =
        db.vaultQueries.selectById(id).asFlow().mapToOneOrNull(ioContext).map { it?.let(::toDto) }

    suspend fun vaultByIdSnapshot(id: String): MobileVault? = withContext(ioContext) {
        db.vaultQueries.selectById(id).executeAsOneOrNull()?.let(::toDto)
    }

    private fun toDto(row: Vault) = MobileVault(row.id, row.name, row.targetAmount, row.currentAmount, row.currencyId, row.color, row.iconName, row.description)
}
