package xyz.scani.mobile.android.screens.detail

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import xyz.scani.mobile.android.ServiceLocator

@Composable
fun AccountDetailScreen(accountId: String) {
    val account by ServiceLocator.accountsRepository.accountById(accountId).collectAsState(initial = null)
    val holdings by ServiceLocator.holdingsRepository.holdingsByAccount(accountId).collectAsState(initial = emptyList())

    if (account == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Not found")
        }
        return
    }

    val a = account!!
    LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
        item {
            Text(a.name, style = MaterialTheme.typography.headlineSmall)
            Text(a.totalValue, style = MaterialTheme.typography.bodyLarge)
        }
        item {
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            Text("Holdings", style = MaterialTheme.typography.titleMedium)
        }
        items(holdings) { h ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
            ) {
                Text("${h.symbol} — ${h.name}", style = MaterialTheme.typography.bodyLarge)
                Text("${h.amount} • ${h.value ?: "—"}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
