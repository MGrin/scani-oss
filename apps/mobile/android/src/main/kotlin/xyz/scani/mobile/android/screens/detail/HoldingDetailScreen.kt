package xyz.scani.mobile.android.screens.detail

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
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
fun HoldingDetailScreen(holdingId: String) {
    val holding by ServiceLocator.holdingsRepository.holdingById(holdingId).collectAsState(initial = null)

    if (holding == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Not found")
        }
        return
    }

    val h = holding!!
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(h.symbol, style = MaterialTheme.typography.headlineSmall)
        Text(h.name, style = MaterialTheme.typography.bodyLarge)
        Text(h.amount, style = MaterialTheme.typography.bodyMedium)
        Text(h.value ?: "—", style = MaterialTheme.typography.bodyMedium)
        Text("Account: ${h.accountId}", style = MaterialTheme.typography.bodySmall)
    }
}
