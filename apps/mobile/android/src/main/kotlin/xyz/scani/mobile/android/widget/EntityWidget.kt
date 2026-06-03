package xyz.scani.mobile.android.widget

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.layout.Column
import androidx.glance.text.Text
import kotlinx.serialization.json.Json
import xyz.scani.mobile.shared.data.WidgetData

class EntityWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = runCatching {
            val text = context.filesDir.resolve("widget.json").readText()
            Json { ignoreUnknownKeys = true }.decodeFromString<WidgetData>(text)
        }.getOrNull()

        provideContent {
            val prefs = currentState<Preferences>()
            val kind = prefs[stringPreferencesKey("kind")]
            val entityId = prefs[stringPreferencesKey("entityId")]

            val entity = if (data != null && kind != null && entityId != null) {
                val list = when (kind) {
                    "account" -> data.accounts
                    "holding" -> data.holdings
                    "group" -> data.groups
                    "vault" -> data.vaults
                    else -> emptyList()
                }
                list.firstOrNull { it.id == entityId }
            } else null

            GlanceTheme {
                Column {
                    Text(entity?.name ?: "Tap to configure")
                    Text(entity?.value ?: "")
                }
            }
        }
    }
}
