package xyz.scani.mobile.shared.auth

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.network.PersistentCookiesStorage
import xyz.scani.mobile.shared.network.createScaniHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AuthRepositoryTest {
    @Test
    fun complete_sign_in_request_paths_and_cookie_captured() = runTest {
        var sawSendPath: String? = null
        var sawVerifyPath: String? = null
        val store = InMemorySecureStorage()
        val jar = PersistentCookiesStorage(store)
        val engine = MockEngine { request ->
            val p = request.url.encodedPath
            if (p.endsWith("send-verification-otp")) {
                sawSendPath = p
                respond(ByteReadChannel("{}"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            } else {
                sawVerifyPath = p
                respond(
                    content = ByteReadChannel("{}"),
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.SetCookie, "scani-app.session_token=tok; Path=/"),
                )
            }
        }
        val http = createScaniHttpClient(engine, jar) {}
        val repo = AuthRepository(AuthApi(http, "https://api.test"), jar)

        assertFalse(repo.isSignedIn())
        repo.requestSignIn("a@b.com")
        repo.completeSignIn("a@b.com", "123456")

        assertTrue(repo.isSignedIn())
        assertTrue(jar.hasAnyCookie())
        assertEquals("/api/auth/email-otp/send-verification-otp", sawSendPath)
        assertEquals("/api/auth/sign-in/email-otp", sawVerifyPath)

        repo.signOut()
        assertFalse(repo.isSignedIn())
        assertFalse(jar.hasAnyCookie())
    }

    @Test
    fun verify_http_error_throws_auth_exception() = runTest {
        val store = InMemorySecureStorage()
        val jar = PersistentCookiesStorage(store)
        val engine = MockEngine {
            respond(ByteReadChannel("""{"error":"bad otp"}"""), HttpStatusCode.Unauthorized, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val http = createScaniHttpClient(engine, jar) {}
        val repo = AuthRepository(AuthApi(http, "https://api.test"), jar)
        assertFailsWith<AuthException> { repo.completeSignIn("a@b.com", "000000") }
    }
}
