package xyz.scani.mobile.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HoldingsScreen() {
    val holdings by ServiceLocator.holdingsRepository.holdings().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var lastSynced by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(Unit) { lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("holdings") }
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    ServiceLocator.syncEngine.syncHoldings()
                    error = null
                } catch (e: Throwable) {
                    error = "Offline — showing cached data"
                } finally {
                    lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("holdings")
                    refreshing = false
                }
            }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Column(Modifier.fillMaxWidth().padding(8.dp)) {
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Text(syncStatusLabel(lastSynced), style = MaterialTheme.typography.bodySmall)
                }
            }
            items(holdings, key = { it.id }) { h ->
                Card(Modifier.fillMaxWidth().padding(8.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Text(h.symbol)
                        Text(h.name)
                        Text(h.amount)
                        Text(h.value ?: "—")
                    }
                }
            }
        }
    }
}
