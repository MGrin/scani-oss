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

class GroupVaultApiTest {
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
    fun groups_parses_list_including_null_description() = runTest {
        val engine = engineFor(
            "mobile.groups" to """{"result":{"data":[
                {"id":"g1","name":"Savings","color":"#FF0000","description":"My savings"},
                {"id":"g2","name":"Investments","color":"#00FF00"}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.groups()
        assertEquals(2, result.size)
        assertEquals(MobileGroup(id = "g1", name = "Savings", color = "#FF0000", description = "My savings"), result[0])
        assertEquals(MobileGroup(id = "g2", name = "Investments", color = "#00FF00", description = null), result[1])
        assertNull(result[1].description)
    }

    @Test
    fun vaults_parses_list_including_null_iconName_and_description() = runTest {
        val engine = engineFor(
            "mobile.vaults" to """{"result":{"data":[
                {"id":"v1","name":"Emergency Fund","targetAmount":"10000.00","currentAmount":"5000.00","currencyId":"USD","color":"#0000FF","iconName":"shield","description":"Rainy day fund"},
                {"id":"v2","name":"Vacation","targetAmount":"3000.00","currentAmount":"1200.00","currencyId":"EUR","color":"#FFFF00"}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.vaults()
        assertEquals(2, result.size)
        assertEquals(MobileVault(id = "v1", name = "Emergency Fund", targetAmount = "10000.00", currentAmount = "5000.00", currencyId = "USD", color = "#0000FF", iconName = "shield", description = "Rainy day fund"), result[0])
        assertEquals(MobileVault(id = "v2", name = "Vacation", targetAmount = "3000.00", currentAmount = "1200.00", currencyId = "EUR", color = "#FFFF00", iconName = null, description = null), result[1])
        assertNull(result[1].iconName)
        assertNull(result[1].description)
    }
}
