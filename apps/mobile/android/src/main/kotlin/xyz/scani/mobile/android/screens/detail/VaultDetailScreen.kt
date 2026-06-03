package xyz.scani.mobile.android.screens.detail

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
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
fun VaultDetailScreen(vaultId: String) {
    val vault by ServiceLocator.vaultsRepository.vaultById(vaultId).collectAsState(initial = null)

    if (vault == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Not found")
        }
        return
    }

    val v = vault!!
    val target = v.targetAmount.toDoubleOrNull() ?: 0.0
    val current = v.currentAmount.toDoubleOrNull() ?: 0.0
    val ratio = if (target <= 0.0) 0f else (current / target).coerceIn(0.0, 1.0).toFloat()

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(v.name, style = MaterialTheme.typography.headlineSmall)
        Text("${v.currentAmount} / ${v.targetAmount}", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 4.dp))
        LinearProgressIndicator(
            progress = { ratio },
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
    }
}
