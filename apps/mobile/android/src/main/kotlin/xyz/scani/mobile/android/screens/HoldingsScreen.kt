package xyz.scani.mobile.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator
import xyz.scani.mobile.shared.data.MobileHolding

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HoldingsScreen(onOpen: (String) -> Unit = {}) {
    val holdings by ServiceLocator.holdingsRepository.holdings().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var lastSynced by remember { mutableStateOf<Long?>(null) }
    var editing by remember { mutableStateOf<MobileHolding?>(null) }
    var deleting by remember { mutableStateOf<MobileHolding?>(null) }

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
                Card(
                    onClick = { onOpen(h.id) },
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(h.symbol)
                            Text(h.name)
                            Text(h.amount)
                            Text(h.value ?: "—")
                        }
                        IconButton(onClick = { editing = h }) {
                            Icon(Icons.Filled.Edit, contentDescription = "Edit holding")
                        }
                        IconButton(onClick = { deleting = h }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Delete holding")
                        }
                    }
                }
            }
        }
    }

    deleting?.let { h ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete holding?") },
            text = { Text("\"${h.name}\" will be removed.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch {
                        ServiceLocator.writeQueue.deleteHolding(h.id)
                        runCatching { ServiceLocator.outboxProcessor.drain() }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }

    editing?.let { h ->
        var balance by remember(h.id) { mutableStateOf(h.amount) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit holding") },
            text = {
                OutlinedTextField(
                    value = balance,
                    onValueChange = { balance = it },
                    label = { Text("Balance") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val savedId = h.id
                    val savedBalance = balance
                    editing = null
                    scope.launch {
                        ServiceLocator.writeQueue.updateHolding(savedId, balance = savedBalance)
                        runCatching { ServiceLocator.outboxProcessor.drain() }
                    }
                }) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = { editing = null }) { Text("Cancel") }
            },
        )
    }
}
