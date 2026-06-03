package xyz.scani.mobile.android.widget

import android.content.Context
import xyz.scani.mobile.shared.data.WidgetStorage

class AndroidWidgetStorage(private val context: Context) : WidgetStorage {
    override fun write(json: String) {
        context.filesDir.resolve("widget.json").writeText(json)
    }
}
