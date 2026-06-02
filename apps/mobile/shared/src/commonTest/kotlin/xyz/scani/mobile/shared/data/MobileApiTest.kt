package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import xyz.scani.mobile.shared.network.TrpcClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
        val engine = engineFor(
            "mobile.accounts" to """{"result":{"data":[
                {"id":"a1","name":"Savings","typeId":"bank","institutionId":"inst1","totalValue":"1000.00"},
                {"id":"a2","name":"Cash","typeId":"cash","totalValue":"50.00"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(engine, "https://api.test"))
        val result = api.accounts()
        assertEquals(2, result.size)
        assertEquals(MobileAccount(id = "a1", name = "Savings", typeId = "bank", institutionId = "inst1", totalValue = "1000.00"), result[0])
        assertEquals(MobileAccount(id = "a2", name = "Cash", typeId = "cash", institutionId = null, totalValue = "50.00"), result[1])
        assertNull(result[1].institutionId)
    }

    @Test
    fun holdings_parses_list_including_null_value() = runTest {
        val engine = engineFor(
            "mobile.holdings" to """{"result":{"data":[
                {"id":"h1","accountId":"a1","symbol":"BTC","name":"Bitcoin","amount":"0.5","value":"30000.00"},
                {"id":"h2","accountId":"a1","symbol":"ETH","name":"Ethereum","amount":"2.0"}
            ]}}""",
        )
        val api = MobileApi(TrpcClient(engine, "https://api.test"))
        val result = api.holdings()
        assertEquals(2, result.size)
        assertEquals(MobileHolding(id = "h1", accountId = "a1", symbol = "BTC", name = "Bitcoin", amount = "0.5", value = "30000.00"), result[0])
        assertEquals(MobileHolding(id = "h2", accountId = "a1", symbol = "ETH", name = "Ethereum", amount = "2.0", value = null), result[1])
        assertNull(result[1].value)
    }
}
