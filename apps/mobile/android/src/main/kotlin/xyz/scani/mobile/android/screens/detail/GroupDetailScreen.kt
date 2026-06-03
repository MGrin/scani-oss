package xyz.scani.mobile.android.screens.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import xyz.scani.mobile.android.ServiceLocator

@Composable
fun GroupDetailScreen(groupId: String) {
    val group by ServiceLocator.groupsRepository.groupById(groupId).collectAsState(initial = null)

    if (group == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Not found")
        }
        return
    }

    val g = group!!
    val swatchColor = runCatching {
        Color(android.graphics.Color.parseColor(g.color))
    }.getOrElse { MaterialTheme.colorScheme.outline }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(24.dp)
                    .background(swatchColor),
            )
            Text(g.name, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(start = 12.dp))
        }
        Text(g.description ?: "—", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
    }
}
