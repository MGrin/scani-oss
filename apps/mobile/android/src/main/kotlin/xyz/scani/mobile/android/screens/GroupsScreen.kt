package xyz.scani.mobile.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator
import xyz.scani.mobile.shared.data.MobileGroup

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupsScreen(onOpen: (String) -> Unit = {}) {
    val groups by ServiceLocator.groupsRepository.groups().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var lastSynced by remember { mutableStateOf<Long?>(null) }
    var editing by remember { mutableStateOf<MobileGroup?>(null) }
    var deleting by remember { mutableStateOf<MobileGroup?>(null) }

    LaunchedEffect(Unit) { lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("groups") }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    ServiceLocator.syncEngine.syncGroups()
                    error = null
                } catch (e: Throwable) {
                    error = "Offline — showing cached data"
                } finally {
                    lastSynced = ServiceLocator.syncStateRepository.lastSyncedAt("groups")
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
            items(groups, key = { it.id }) { g ->
                Card(
                    onClick = { onOpen(g.id) },
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val swatchColor = runCatching {
                            Color(android.graphics.Color.parseColor(g.color))
                        }.getOrElse { MaterialTheme.colorScheme.outline }
                        Box(
                            Modifier
                                .size(16.dp)
                                .background(swatchColor)
                                .padding(end = 8.dp),
                        )
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(g.name, style = MaterialTheme.typography.bodyLarge)
                            g.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                        IconButton(onClick = { editing = g }) {
                            Icon(Icons.Filled.Edit, contentDescription = "Edit group")
                        }
                        IconButton(onClick = { deleting = g }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Delete group")
                        }
                    }
                }
            }
        }
    }

    deleting?.let { g ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete group?") },
            text = { Text("\"${g.name}\" will be removed.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch {
                        ServiceLocator.writeQueue.deleteGroup(g.id)
                        runCatching { ServiceLocator.outboxProcessor.drain() }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }

    editing?.let { g ->
        var name by remember(g.id) { mutableStateOf(g.name) }
        var color by remember(g.id) { mutableStateOf(g.color) }
        var description by remember(g.id) { mutableStateOf(g.description ?: "") }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit group") },
            text = {
                Column {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("Color", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.height(4.dp))
                    ColorPickerRow(selected = color, onPick = { color = it })
                    OutlinedTextField(
                        value = description,
                        onValueChange = { description = it },
                        label = { Text("Description") },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val savedId = g.id
                    val savedName = name
                    val savedColor = color
                    val savedDesc = description.ifBlank { null }
                    editing = null
                    scope.launch {
                        ServiceLocator.writeQueue.updateGroup(savedId, savedName, savedColor, savedDesc)
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
