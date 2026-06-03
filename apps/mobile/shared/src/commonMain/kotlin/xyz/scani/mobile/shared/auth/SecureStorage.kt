package xyz.scani.mobile.shared.auth

// Pluggable secure key/value store. Platform actuals (Keychain / EncryptedShared-
// Preferences) are provided by the app modules; commonTest uses an in-memory fake.
interface SecureStorage {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
}
