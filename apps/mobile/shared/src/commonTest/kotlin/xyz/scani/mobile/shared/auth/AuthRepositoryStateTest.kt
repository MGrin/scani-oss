package xyz.scani.mobile.shared.auth

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.network.PersistentCookiesStorage
import xyz.scani.mobile.shared.network.createScaniHttpClient
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AuthRepositoryStateTest {
    private fun makeRepo(preloadCookie: Boolean = false): Pair<AuthRepository, PersistentCookiesStorage> {
        val store = InMemorySecureStorage()
        val jar = PersistentCookiesStorage(store)
        val engine = MockEngine { request ->
            val p = request.url.encodedPath
            when {
                p.endsWith("send-verification-otp") ->
                    respond(ByteReadChannel("{}"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                p.endsWith("email-otp") ->
                    respond(
                        content = ByteReadChannel("{}"),
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.SetCookie, "scani-app.session_token=tok; Path=/"),
                    )
                p.endsWith("sign-out") ->
                    respond(ByteReadChannel("{}"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                else ->
                    respond(ByteReadChannel("{}"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }
        val http = createScaniHttpClient(engine, jar) {}
        val api = AuthApi(http, "https://api.test")
        if (preloadCookie) {
            // Simulate a previously-persisted cookie via the storage key directly so
            // the jar loads it on construction (tests the initial-state path).
            store.putString(
                "scani.cookies",
                """[{"name":"scani-app.session_token","value":"tok","domain":null,"path":"/"}]""",
            )
        }
        val cookieJarForRepo = if (preloadCookie) PersistentCookiesStorage(store) else jar
        return AuthRepository(api, cookieJarForRepo) to cookieJarForRepo
    }

    @Test
    fun fresh_storage_signedIn_is_false() = runTest {
        val (repo, _) = makeRepo()
        assertFalse(repo.signedIn.first())
        assertFalse(repo.isSignedIn())
    }

    @Test
    fun initial_cookie_signedIn_is_true() = runTest {
        val (repo, jar) = makeRepo(preloadCookie = true)
        assertTrue(repo.signedIn.first())
        assertTrue(jar.hasAnyCookie())
    }

    @Test
    fun completeSignIn_sets_cookie_and_signedIn_true() = runTest {
        val (repo, jar) = makeRepo()
        repo.completeSignIn("a@b.c", "123456")
        assertTrue(repo.signedIn.first())
        assertTrue(jar.hasAnyCookie())
    }

    @Test
    fun signOut_clears_cookie_and_signedIn_false() = runTest {
        val (repo, jar) = makeRepo()
        repo.completeSignIn("a@b.c", "123456")
        assertTrue(jar.hasAnyCookie())
        repo.signOut()
        assertFalse(repo.signedIn.first())
        assertFalse(jar.hasAnyCookie())
    }

    @Test
    fun onUnauthorized_clears_cookie_and_signedIn_false() = runTest {
        val (repo, jar) = makeRepo()
        repo.completeSignIn("a@b.c", "123456")
        assertTrue(jar.hasAnyCookie())
        repo.onUnauthorized()
        assertFalse(repo.signedIn.first())
        assertFalse(jar.hasAnyCookie())
    }
}
