package xyz.scani.mobile.shared.network

import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.http.Cookie
import io.ktor.http.Url
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import xyz.scani.mobile.shared.auth.SecureStorage

@Serializable
private data class StoredCookie(val name: String, val value: String, val domain: String? = null, val path: String? = null)

class PersistentCookiesStorage(private val storage: SecureStorage) : CookiesStorage {
    private val json = Json { ignoreUnknownKeys = true }
    private val cookies = mutableListOf<Cookie>()

    init {
        storage.getString(KEY)?.let { raw ->
            runCatching { json.decodeFromString<List<StoredCookie>>(raw) }.getOrNull()?.forEach {
                cookies.add(Cookie(it.name, it.value, domain = it.domain, path = it.path))
            }
        }
    }

    override suspend fun get(requestUrl: Url): List<Cookie> = cookies.toList()

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) {
        if (cookie.name.isBlank()) return
        cookies.removeAll { it.name == cookie.name }
        cookies.add(cookie)
        persist()
    }

    override fun close() {}

    fun hasAnyCookie(): Boolean = cookies.isNotEmpty()

    fun clear() {
        cookies.clear()
        storage.remove(KEY)
    }

    private fun persist() {
        val snapshot = cookies.map { StoredCookie(it.name, it.value, it.domain, it.path) }
        storage.putString(KEY, json.encodeToString(snapshot))
    }

    private companion object {
        const val KEY = "scani.cookies"
    }
}
