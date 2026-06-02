package xyz.scani.mobile.shared.data

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.native.inMemoryDriver
import xyz.scani.mobile.shared.db.ScaniDatabase

actual fun createTestDriver(): SqlDriver = inMemoryDriver(ScaniDatabase.Schema)
