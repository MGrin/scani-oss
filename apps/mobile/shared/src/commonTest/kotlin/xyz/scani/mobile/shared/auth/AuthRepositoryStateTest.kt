package xyz.scani.mobile.shared.auth

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AuthRepositoryStateTest {
    private fun makeRepo(token: String?): AuthRepository {
        val store = InMemorySecureStorage()
        if (token != null) store.putString("scani.auth.token", token)
        val engine = MockEngine { request ->
            val p = request.url.encodedPath
            if (p.endsWith("send-verification-otp")) {
                respond("""{"success":true}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            } else {
                respond(
                    content = """{"token":"sess_test","user":{"id":"u1"}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(
                        HttpHeaders.ContentType to listOf("application/json"),
                        "set-auth-token" to listOf("sess_test"),
                    ),
                )
            }
        }
        return AuthRepository(AuthApi(engine, "https://api.test"), store)
    }

    @Test
    fun signedIn_reflects_initial_token() = runTest {
        assertFalse(makeRepo(token = null).signedIn.first())
        assertTrue(makeRepo(token = "t").signedIn.first())
    }

    @Test
    fun completeSignIn_then_signOut_flips_signedIn() = runTest {
        val repo = makeRepo(token = null)
        repo.completeSignIn("a@b.c", "123456")
        assertTrue(repo.signedIn.first())
        repo.signOut()
        assertFalse(repo.signedIn.first())
    }
}
