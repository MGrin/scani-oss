package xyz.scani.mobile.android.widget

import androidx.glance.GlanceId
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.Column
import androidx.glance.text.Text
import android.content.Context
import kotlinx.serialization.json.Json
import xyz.scani.mobile.shared.data.WidgetData

class PortfolioWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = runCatching {
            val text = context.filesDir.resolve("widget.json").readText()
            Json { ignoreUnknownKeys = true }.decodeFromString<WidgetData>(text)
        }.getOrNull()

        provideContent {
            GlanceTheme {
                Column {
                    Text("Portfolio")
                    Text(data?.portfolioTotal ?: "Open Scani")
                }
            }
        }
    }
}
