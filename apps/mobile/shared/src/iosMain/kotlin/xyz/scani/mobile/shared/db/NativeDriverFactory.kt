package xyz.scani.mobile.shared.db

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.native.NativeSqliteDriver

class NativeDriverFactory : DriverFactory {
    override fun create(): SqlDriver = NativeSqliteDriver(ScaniDatabase.Schema, "scani.db")
}
