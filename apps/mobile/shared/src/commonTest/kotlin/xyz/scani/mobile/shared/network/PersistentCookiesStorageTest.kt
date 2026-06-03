package xyz.scani.mobile.shared.network

import io.ktor.http.Cookie
import io.ktor.http.Url
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.auth.SecureStorage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeStorage : SecureStorage {
    val map = mutableMapOf<String, String>()
    override fun getString(key: String) = map[key]
    override fun putString(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
}

class PersistentCookiesStorageTest {
    @Test
    fun addCookie_persists_and_get_returns_it() = runTest {
        val storage = FakeStorage()
        val jar = PersistentCookiesStorage(storage)
        jar.addCookie(Url("https://api.test"), Cookie("scani-app.session_token", "tok", domain = "api.test", path = "/"))
        assertEquals("tok", jar.get(Url("https://api.test")).first { it.name == "scani-app.session_token" }.value)
        assertTrue(jar.hasAnyCookie())
    }

    @Test
    fun a_new_instance_loads_persisted_cookies() = runTest {
        val storage = FakeStorage()
        PersistentCookiesStorage(storage).addCookie(Url("https://api.test"), Cookie("s", "v", domain = "api.test", path = "/"))
        val reloaded = PersistentCookiesStorage(storage)
        assertTrue(reloaded.hasAnyCookie())
        assertEquals("v", reloaded.get(Url("https://api.test")).first { it.name == "s" }.value)
    }

    @Test
    fun clear_empties_jar_and_storage() = runTest {
        val storage = FakeStorage()
        val jar = PersistentCookiesStorage(storage)
        jar.addCookie(Url("https://api.test"), Cookie("s", "v"))
        jar.clear()
        assertFalse(jar.hasAnyCookie())
        assertTrue(jar.get(Url("https://api.test")).isEmpty())
    }
}
