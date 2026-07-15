package xyz.scani.mobile.shared.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import xyz.scani.trpc.TrpcClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ScreenshotUploadServiceTest {
    @Test
    fun upload_fires_presign_put_parse_in_order() = runTest {
        val imageBytes = byteArrayOf(1, 2, 3)
        val requestLog = mutableListOf<String>()
        var capturedPutBody: ByteArray? = null
        var capturedPutContentType: String? = null
        var capturedParseBody: String? = null

        val engine = MockEngine { request ->
            val method = request.method
            val path = request.url.encodedPath
            requestLog.add("${method.value} $path")

            when {
                method == HttpMethod.Post && path == "/trpc/storage.getUploadUrl" -> respond(
                    content = """{"result":{"data":{"uploadUrl":"https://r2.test/put/abc","key":"screenshot/u/abc","headers":{"Content-Type":"image/png"}}}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
                method == HttpMethod.Put && request.url.toString().startsWith("https://r2.test/put/abc") -> {
                    capturedPutBody = request.body.toByteArray()
                    capturedPutContentType = request.body.contentType?.toString()
                        ?: request.headers[HttpHeaders.ContentType]
                    respond(
                        content = "",
                        status = HttpStatusCode.OK,
                        headers = headersOf(),
                    )
                }
                method == HttpMethod.Post && path == "/trpc/screenshots.parseScreenshots" -> {
                    capturedParseBody = request.body.toByteArray().decodeToString()
                    respond(
                        content = """{"result":{"data":{"jobId":"j1"}}}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
                else -> error("Unexpected request: ${method.value} ${request.url} encodedPath=$path")
            }
        }

        val http = HttpClient(engine) {
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            expectSuccess = false
        }
        val trpc = TrpcClient(http, "https://api.test")
        val service = ScreenshotUploadService(http, trpc, genId = { "req-1" })

        service.upload(imageBytes, "shot.png", "image/png", "a1")

        assertEquals(3, requestLog.size, "requests: $requestLog")
        assertEquals("POST /trpc/storage.getUploadUrl", requestLog[0])
        assertEquals("PUT /put/abc", requestLog[1])
        assertEquals("POST /trpc/screenshots.parseScreenshots", requestLog[2])

        val putBody = checkNotNull(capturedPutBody) { "capturedPutBody was null, log=$requestLog" }
        assertTrue(putBody.contentEquals(imageBytes), "bytes mismatch")
        assertTrue(capturedPutContentType?.contains("image/png") == true, "content-type was $capturedPutContentType")

        val parseJson = Json.parseToJsonElement(capturedParseBody!!).jsonObject
        val r2Keys = parseJson["r2Keys"]!!.jsonArray
        assertEquals(1, r2Keys.size)
        assertEquals("screenshot/u/abc", r2Keys[0].jsonPrimitive.content)
        val requestId = parseJson["requestId"]!!.jsonPrimitive.content
        assertTrue(requestId.isNotEmpty())
        assertEquals("a1", parseJson["accountId"]!!.jsonPrimitive.content)
    }
}
