package xyz.scani.mobile.shared.db

import android.content.Context
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver

class AndroidDriverFactory(private val context: Context) : DriverFactory {
    override fun create(): SqlDriver = AndroidSqliteDriver(ScaniDatabase.Schema, context, "scani.db")
}
