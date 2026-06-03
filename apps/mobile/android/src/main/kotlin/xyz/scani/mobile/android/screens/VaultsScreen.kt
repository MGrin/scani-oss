package xyz.scani.mobile.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import xyz.scani.mobile.shared.data.MobileVault

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultsScreen() {
    val vaults by ServiceLocator.vaultsRepository.vaults().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var lastSynced by remember { mutableStateOf<Long?>(null) }
    var editing by remember { mutableStateOf<MobileVault?>(null) }
    var deleting by remember { mutableStateOf<MobileVault?>(null) }

    LaunchedEffect(Unit) { lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("vaults") }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    ServiceLocator.syncEngine.syncVaults()
                    error = null
                } catch (e: Throwable) {
                    error = "Offline — showing cached data"
                } finally {
                    lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("vaults")
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
            items(vaults, key = { it.id }) { v ->
                Card(
                    onClick = { editing = v },
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(v.name, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                "${v.currentAmount} / ${v.targetAmount}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        IconButton(onClick = { deleting = v }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Delete vault")
                        }
                    }
                }
            }
        }
    }

    deleting?.let { v ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete vault?") },
            text = { Text("\"${v.name}\" will be removed.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch {
                        ServiceLocator.writeQueue.deleteVault(v.id)
                        runCatching { ServiceLocator.outboxProcessor.drain() }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }

    editing?.let { v ->
        var name by remember(v.id) { mutableStateOf(v.name) }
        var targetAmount by remember(v.id) { mutableStateOf(v.targetAmount) }
        var color by remember(v.id) { mutableStateOf(v.color) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit vault") },
            text = {
                Column {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = targetAmount,
                        onValueChange = { targetAmount = it },
                        label = { Text("Target amount") },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("Color", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.height(4.dp))
                    ColorPickerRow(selected = color, onPick = { color = it })
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val savedId = v.id
                    val savedName = name
                    val savedTarget = targetAmount
                    val savedColor = color
                    editing = null
                    scope.launch {
                        ServiceLocator.writeQueue.updateVault(savedId, name = savedName, targetAmount = savedTarget, color = savedColor)
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
