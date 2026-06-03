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
import xyz.scani.mobile.shared.data.MobileAccount

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountsScreen() {
    val accounts by ServiceLocator.accountsRepository.accounts().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var lastSynced by remember { mutableStateOf<Long?>(null) }
    var editing by remember { mutableStateOf<MobileAccount?>(null) }
    var deleting by remember { mutableStateOf<MobileAccount?>(null) }

    LaunchedEffect(Unit) { lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("accounts") }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    ServiceLocator.syncEngine.syncAccounts()
                    error = null
                } catch (e: Throwable) {
                    error = "Offline — showing cached data"
                } finally {
                    lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("accounts")
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
            items(accounts, key = { it.id }) { a ->
                Card(
                    onClick = { editing = a },
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(a.name)
                            Text(a.totalValue)
                        }
                        IconButton(onClick = { deleting = a }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Delete account")
                        }
                    }
                }
            }
        }
    }

    deleting?.let { a ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete account?") },
            text = { Text("\"${a.name}\" will be removed.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch {
                        ServiceLocator.writeQueue.deleteAccount(a.id)
                        runCatching { ServiceLocator.outboxProcessor.drain() }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }

    editing?.let { a ->
        var name by remember(a.id) { mutableStateOf(a.name) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit account") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val savedId = a.id
                    val savedName = name
                    editing = null
                    scope.launch {
                        ServiceLocator.writeQueue.updateAccount(savedId, name = savedName)
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
