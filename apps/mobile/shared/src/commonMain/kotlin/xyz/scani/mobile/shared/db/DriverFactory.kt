package xyz.scani.mobile.shared.db

import app.cash.sqldelight.db.SqlDriver

interface DriverFactory {
    fun create(): SqlDriver
}
