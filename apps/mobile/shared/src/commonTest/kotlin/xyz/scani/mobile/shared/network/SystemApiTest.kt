package xyz.scani.mobile.shared.network

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class SystemApiTest {
    @Test
    fun ping_returns_parsed_status_and_service() = runTest {
        var requestedPath: String? = null
        val engine = MockEngine { request ->
            requestedPath = request.url.encodedPath
            respond(
                content = """{"result":{"data":{"status":"ok","service":"api"}}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = SystemApi(TrpcClient(engine, "https://api.test"))
        assertEquals(PingResult(status = "ok", service = "api"), api.ping())
        assertEquals("/trpc/system.ping", requestedPath)
    }
}
