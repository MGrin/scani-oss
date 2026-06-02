package xyz.scani.mobile.android.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import xyz.scani.mobile.shared.auth.SecureStorage

// EncryptedSharedPreferences keeps the bearer token encrypted at rest under an
// AndroidKeyStore master key. (Jetpack Security is deprecated but the simplest
// hardened store; revisit with a Keystore AES-GCM wrapper if needed.)
class AndroidSecureStorage(context: Context) : SecureStorage {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context.applicationContext,
        "scani_secure_prefs",
        MasterKey.Builder(context.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}
