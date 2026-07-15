package xyz.scani.mobile.android.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.fragment.app.FragmentActivity
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import xyz.scani.mobile.shared.data.WidgetData
import xyz.scani.mobile.shared.data.WidgetEntity

class EntityWidgetConfigActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val appWidgetId = intent.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        )
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        setResult(RESULT_CANCELED)

        val data = runCatching {
            val text = filesDir.resolve("widget.json").readText()
            Json { ignoreUnknownKeys = true }.decodeFromString<WidgetData>(text)
        }.getOrNull()

        val kinds = listOf("account", "holding", "group", "vault")
        val kindLabels = listOf("Accounts", "Holdings", "Groups", "Vaults")

        setContent {
            val scope = rememberCoroutineScope()
            var selectedKindIndex by remember { mutableIntStateOf(0) }

            MaterialTheme {
                Surface {
                    Column {
                        PrimaryTabRow(selectedTabIndex = selectedKindIndex) {
                            kindLabels.forEachIndexed { index, label ->
                                Tab(
                                    selected = selectedKindIndex == index,
                                    onClick = { selectedKindIndex = index },
                                    text = { Text(label) }
                                )
                            }
                        }
                        val entities: List<WidgetEntity> = when (selectedKindIndex) {
                            0 -> data?.accounts
                            1 -> data?.holdings
                            2 -> data?.groups
                            3 -> data?.vaults
                            else -> null
                        } ?: emptyList()
                        LazyColumn {
                            items(entities) { entity ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            val kind = kinds[selectedKindIndex]
                                            scope.launch {
                                                val glanceId = GlanceAppWidgetManager(this@EntityWidgetConfigActivity)
                                                    .getGlanceIdBy(appWidgetId)
                                                updateAppWidgetState(
                                                    this@EntityWidgetConfigActivity,
                                                    glanceId
                                                ) { prefs ->
                                                    prefs[stringPreferencesKey("kind")] = kind
                                                    prefs[stringPreferencesKey("entityId")] = entity.id
                                                }
                                                EntityWidget().update(
                                                    this@EntityWidgetConfigActivity,
                                                    glanceId
                                                )
                                                setResult(
                                                    RESULT_OK,
                                                    Intent().putExtra(
                                                        AppWidgetManager.EXTRA_APPWIDGET_ID,
                                                        appWidgetId
                                                    )
                                                )
                                                finish()
                                            }
                                        }
                                        .padding(16.dp)
                                ) {
                                    Column {
                                        Text(text = entity.name, style = MaterialTheme.typography.bodyLarge)
                                        Text(text = entity.value, style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }
        }
    }
}
