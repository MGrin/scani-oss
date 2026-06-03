package xyz.scani.mobile.shared.navigation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DeepLinksTest {
    @Test
    fun parses_entity_paths() {
        assertEquals(Destination.Holding("h1"), DeepLinks.parse("https://app.scani.xyz/holding/h1"))
        assertEquals(Destination.Account("a1"), DeepLinks.parse("https://app.scani.xyz/account/a1"))
        assertEquals(Destination.Institution("i1"), DeepLinks.parse("https://app.scani.xyz/institution/i1"))
        assertEquals(Destination.Vault("v1"), DeepLinks.parse("https://app.scani.xyz/vault/v1"))
        assertEquals(Destination.Group("g1"), DeepLinks.parse("https://app.scani.xyz/group/g1"))
        assertEquals(Destination.Job("j1"), DeepLinks.parse("https://app.scani.xyz/job/j1"))
    }

    @Test
    fun parses_tabs_and_auth_callback() {
        assertEquals(Destination.Dashboard, DeepLinks.parse("https://app.scani.xyz/"))
        assertEquals(Destination.Dashboard, DeepLinks.parse("https://app.scani.xyz/dashboard"))
        assertEquals(Destination.AuthCallback, DeepLinks.parse("https://app.scani.xyz/auth/callback?token=x"))
    }

    @Test
    fun ignores_query_and_trailing_slash() {
        assertEquals(Destination.Holding("h1"), DeepLinks.parse("https://app.scani.xyz/holding/h1/"))
        assertEquals(Destination.Holding("h1"), DeepLinks.parse("https://app.scani.xyz/holding/h1?ref=email"))
    }

    @Test
    fun returns_null_for_unknown_or_malformed() {
        assertNull(DeepLinks.parse("https://app.scani.xyz/unknown/x"))
        assertNull(DeepLinks.parse("https://app.scani.xyz/holding"))
        assertNull(DeepLinks.parse("not a url"))
        assertNull(DeepLinks.parse("https://evil.example.com/holding/h1"))
    }
}
