package xyz.scani.mobile.shared

import kotlin.test.Test
import kotlin.test.assertTrue

class GreetingTest {
    @Test
    fun greeting_includes_platform_name() {
        val result = Greeting().greet()
        assertTrue(result.contains("Scani"), "greeting should mention the app: $result")
        assertTrue(
            result.contains("Android") || result.contains("iOS"),
            "greeting should mention the platform: $result",
        )
    }
}
