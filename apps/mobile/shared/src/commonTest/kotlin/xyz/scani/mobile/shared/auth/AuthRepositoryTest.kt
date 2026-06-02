package xyz.scani.mobile.shared.auth

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AuthRepositoryTest {
    @Test
    fun complete_sign_in_persists_bearer_token() = runTest {
        var sawSendPath: String? = null
        var sawVerifyPath: String? = null
        val engine = MockEngine { request ->
            val p = request.url.encodedPath
            if (p.endsWith("send-verification-otp")) {
                sawSendPath = p
                respond("""{"success":true}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            } else {
                sawVerifyPath = p
                respond(
                    content = """{"token":"sess_abc","user":{"id":"u1"}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(
                        HttpHeaders.ContentType to listOf("application/json"),
                        "set-auth-token" to listOf("sess_abc"),
                    ),
                )
            }
        }
        val store = InMemorySecureStorage()
        val repo = AuthRepository(AuthApi(engine, "https://api.test"), store)

        assertTrue(!repo.isSignedIn())
        repo.requestSignIn("a@b.com")
        repo.completeSignIn("a@b.com", "123456")

        assertTrue(repo.isSignedIn())
        assertEquals("sess_abc", repo.token())
        assertEquals("/api/auth/email-otp/send-verification-otp", sawSendPath)
        assertEquals("/api/auth/sign-in/email-otp", sawVerifyPath)

        repo.signOut()
        assertTrue(!repo.isSignedIn())
    }

    @Test
    fun verify_without_token_header_fails() = runTest {
        val engine = MockEngine {
            respond("""{"error":"bad otp"}""", HttpStatusCode.Unauthorized, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val repo = AuthRepository(AuthApi(engine, "https://api.test"), InMemorySecureStorage())
        assertFailsWith<AuthException> { repo.completeSignIn("a@b.com", "000000") }
    }

    @Test
    fun verify_missing_token_header_on_200_fails() = runTest {
        val engine = MockEngine {
            respond(
                content = """{"token":null}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val repo = AuthRepository(AuthApi(engine, "https://api.test"), InMemorySecureStorage())
        assertFailsWith<AuthException> { repo.completeSignIn("a@b.com", "123456") }
    }
}
