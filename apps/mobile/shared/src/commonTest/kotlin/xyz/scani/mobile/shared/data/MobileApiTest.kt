package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MobileApiTest {
    private fun engineFor(vararg pairs: Pair<String, String>) = MockEngine { request ->
        val path = request.url.encodedPath.removePrefix("/trpc/")
        val body = pairs.toMap()[path] ?: error("Unexpected path: $path")
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    @Test
    fun accounts_parses_list_including_null_institutionId() = runTest {
        var capturedPath = ""
        val engine = MockEngine { request ->
            capturedPath = request.url.encodedPath
            respond(
                content = """{"result":{"data":[
                    {"id":"a1","name":"Bank","typeId":"t1","institutionId":"i1","summary":{"totalValue":"100.50"}},
                    {"id":"a2","name":"Cash","typeId":"t2","summary":{"totalValue":"50.00"}}
                ]}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.accounts()
        assertTrue(capturedPath.contains("accounts.getByUserIdWithSummary"))
        assertEquals(2, result.size)
        assertEquals(MobileAccount(id = "a1", name = "Bank", typeId = "t1", institutionId = "i1", totalValue = "100.50"), result[0])
        assertEquals(MobileAccount(id = "a2", name = "Cash", typeId = "t2", institutionId = null, totalValue = "50.00"), result[1])
        assertNull(result[1].institutionId)
    }

    @Test
    fun holdings_parses_list_including_null_value() = runTest {
        val engine = engineFor(
            "holdings.getWithDetails" to """{"result":{"data":[
                {"id":"h1","token":{"symbol":"BTC","name":"Bitcoin"},"amount":1.5,"value":90000,"account":{"id":"a1"}},
                {"id":"h2","token":{"symbol":"ETH","name":"Ether"},"amount":2,"value":null,"account":{"id":"a1"}}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.holdings()
        assertEquals(2, result.size)
        assertEquals(MobileHolding(id = "h1", accountId = "a1", symbol = "BTC", name = "Bitcoin", amount = "1.5", value = "90000"), result[0])
        assertEquals(MobileHolding(id = "h2", accountId = "a1", symbol = "ETH", name = "Ether", amount = "2", value = null), result[1])
        assertNull(result[1].value)
    }
}
