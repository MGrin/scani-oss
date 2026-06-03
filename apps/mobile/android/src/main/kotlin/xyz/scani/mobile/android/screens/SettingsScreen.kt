package xyz.scani.mobile.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.ServiceLocator
import xyz.scani.mobile.shared.db.Outbox

@Composable
fun SettingsScreen() {
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<List<Outbox>>(emptyList()) }

    suspend fun refresh() {
        pending = ServiceLocator.outboxRepository.pending()
    }

    suspend fun resyncEntity(entity: String) {
        runCatching {
            when (entity) {
                "account" -> ServiceLocator.syncEngine.syncAccounts()
                "holding" -> ServiceLocator.syncEngine.syncHoldings()
                "group" -> ServiceLocator.syncEngine.syncGroups()
                "vault" -> ServiceLocator.syncEngine.syncVaults()
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text("Sync queue", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = { scope.launch { refresh() } }) {
                Text("Refresh")
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "${pending.size} queued write(s)",
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(8.dp))
        if (pending.isEmpty()) {
            Text("All changes synced ✓")
        } else {
            for (item in pending) {
                Spacer(Modifier.height(8.dp))
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("${item.op} ${item.entity}", style = MaterialTheme.typography.bodyLarge)
                        if (item.attempts >= 1) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                item.lastError ?: "Failed",
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        Row {
                            Button(onClick = {
                                scope.launch {
                                    runCatching { ServiceLocator.outboxProcessor.drain() }
                                    refresh()
                                }
                            }) {
                                Text("Retry")
                            }
                            Spacer(Modifier.weight(1f))
                            OutlinedButton(
                                onClick = {
                                    scope.launch {
                                        ServiceLocator.outboxRepository.markDone(item.id)
                                        resyncEntity(item.entity)
                                        refresh()
                                    }
                                },
                                colors = ButtonDefaults.outlinedButtonColors(
                                    contentColor = MaterialTheme.colorScheme.error,
                                ),
                            ) {
                                Text("Discard")
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { scope.launch { ServiceLocator.authRepository.signOut() } },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
            ),
        ) {
            Text("Sign out")
        }
    }
}
