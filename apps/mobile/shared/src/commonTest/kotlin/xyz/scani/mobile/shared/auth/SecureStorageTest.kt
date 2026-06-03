package xyz.scani.mobile.shared.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SecureStorageTest {
    @Test
    fun put_get_remove_round_trip() {
        val store: SecureStorage = InMemorySecureStorage()
        assertNull(store.getString("k"))
        store.putString("k", "v")
        assertEquals("v", store.getString("k"))
        store.remove("k")
        assertNull(store.getString("k"))
    }
}
